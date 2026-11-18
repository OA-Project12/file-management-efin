"use client";

import { useEffect, useRef, useState } from "react";
import { AnnotationMode, getDocument, PDFWorker, VerbosityLevel, version } from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PreviewFailure } from "./preview-content";

const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_SIDE = 4096;
const PDF_TIMEOUT_MS = 20_000;
const ASSETS = `/pdfjs/${version}/`;

export default function PdfPreview({ bytes, onError }: { bytes: Uint8Array<ArrayBuffer>; onError: (failure: PreviewFailure) => void }) {
    const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
    const [page, setPage] = useState(1);
    const [zoom, setZoom] = useState(100);
    const [fitWidth, setFitWidth] = useState(0);
    const [renderedPage, setRenderedPage] = useState("");
    const viewportElement = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const renderKey = `${page}:${zoom}:${fitWidth}`;

    useEffect(() => {
        let active = true;
        let port: Worker | undefined;
        let worker: PDFWorker | undefined;
        let loading: ReturnType<typeof getDocument> | undefined;
        const fail = () => {
            if (active) onError("pdf_failed");
        };
        const timeout = window.setTimeout(fail, PDF_TIMEOUT_MS);
        try {
            port = new Worker(`${ASSETS}pdf.worker.min.mjs`, { type: "module" });
            port.addEventListener("error", fail);
            port.addEventListener("messageerror", fail);
            worker = PDFWorker.create({ port, verbosity: VerbosityLevel.ERRORS });
            loading = getDocument({
                // The worker owns the transferred buffer. Keep the caller's bytes intact for React effect replays.
                data: bytes.slice(),
                worker,
                verbosity: VerbosityLevel.ERRORS,
                cMapUrl: `${ASSETS}cmaps/`,
                standardFontDataUrl: `${ASSETS}standard_fonts/`,
                iccUrl: `${ASSETS}iccs/`,
                enableXfa: false,
                useWasm: false,
                disableWorkerRendering: true,
                disableFontFace: true,
            });
            loading.onPassword = () => {
                if (active) onError("pdf_password");
            };
            void loading.promise.then((document) => {
                clearTimeout(timeout);
                if (active) setPdf(document);
            }, fail);
        } catch {
            fail();
        }
        return () => {
            active = false;
            clearTimeout(timeout);
            port?.removeEventListener("error", fail);
            port?.removeEventListener("messageerror", fail);
            const disposeWorker = () => {
                worker?.destroy();
                port?.terminate();
            };
            if (!loading) {
                disposeWorker();
                return;
            }
            // Give PDF.js a chance to release its transport even if the worker has stopped responding.
            const deadline = window.setTimeout(disposeWorker, 1000);
            void loading
                .destroy()
                .catch(() => undefined)
                .finally(() => {
                    clearTimeout(deadline);
                    disposeWorker();
                });
        };
    }, [bytes, onError]);

    useEffect(() => {
        const element = viewportElement.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setFitWidth(Math.floor(entry.contentRect.width)));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const target = canvas.current;
        if (!pdf || !target || fitWidth < 1) return;

        let active = true;
        let renderTask: RenderTask | undefined;
        const fail = () => {
            if (active) onError("pdf_failed");
        };
        const timeout = window.setTimeout(fail, PDF_TIMEOUT_MS);
        void (async () => {
            const pdfPage = await pdf.getPage(page);
            if (!active) return;
            const original = pdfPage.getViewport({ scale: 1 });
            const scale = (fitWidth / original.width) * (zoom / 100);
            const cssViewport = pdfPage.getViewport({ scale });
            const pixelScale = Math.min(
                window.devicePixelRatio || 1,
                Math.sqrt(MAX_CANVAS_PIXELS / (cssViewport.width * cssViewport.height)),
                MAX_CANVAS_SIDE / cssViewport.width,
                MAX_CANVAS_SIDE / cssViewport.height,
            );
            const viewport = pdfPage.getViewport({ scale: scale * pixelScale });
            target.width = Math.max(1, Math.floor(viewport.width));
            target.height = Math.max(1, Math.floor(viewport.height));
            target.style.width = `${cssViewport.width}px`;
            renderTask = pdfPage.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE });
            await renderTask.promise;
            if (active) setRenderedPage(renderKey);
        })()
            .catch(fail)
            .finally(() => clearTimeout(timeout));

        return () => {
            active = false;
            clearTimeout(timeout);
            renderTask?.cancel();
        };
    }, [pdf, page, zoom, fitWidth, renderKey, onError]);

    return (
        <div className="pdf-preview">
            {pdf && (
                <div className="pdf-preview-controls" role="group" aria-label="การอ่าน PDF">
                    <button type="button" className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                        หน้าก่อนหน้า
                    </button>
                    <span role="status">
                        หน้า {page} / {pdf.numPages}
                    </span>
                    <button type="button" className="secondary" disabled={page >= pdf.numPages} onClick={() => setPage(page + 1)}>
                        หน้าถัดไป
                    </button>
                    <button type="button" className="secondary" disabled={zoom <= 75} onClick={() => setZoom(zoom - 25)}>
                        ซูมออก
                    </button>
                    <button
                        type="button"
                        className="secondary"
                        disabled={zoom === 100}
                        aria-label="คืนค่าซูม 100%"
                        onClick={() => setZoom(100)}
                    >
                        {zoom}%
                    </button>
                    <button type="button" className="secondary" disabled={zoom >= 200} onClick={() => setZoom(zoom + 25)}>
                        ซูมเข้า
                    </button>
                </div>
            )}
            {(!pdf || renderedPage !== renderKey) && <p role="status">กำลังเปิดหน้า PDF…</p>}
            <div className="pdf-preview-viewport" ref={viewportElement} tabIndex={0} role="region" aria-label="หน้าเอกสาร PDF">
                {pdf && fitWidth > 0 && (
                    <canvas
                        key={renderKey}
                        ref={canvas}
                        style={{ visibility: renderedPage === renderKey ? "visible" : "hidden" }}
                        role="img"
                        aria-label={`PDF หน้า ${page} จาก ${pdf.numPages}`}
                    />
                )}
            </div>
        </div>
    );
}
