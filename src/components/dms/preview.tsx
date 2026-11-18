"use client";
import { invalidateRequest } from "@/components/dms/model";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Download, Eye, RefreshCw } from "lucide-react";
import type { Api } from "./model";
import { errorText, isDenied } from "./model";
import { Notice } from "./common";
import { PREVIEW_URL_TTL_SECONDS } from "@/domain/files/preview-policy";
import { loadPreviewContent, PreviewError, previewFailureText, type PreviewFailure } from "./preview-content";

const PdfPreview = dynamic(() => import("./pdf-preview"), {
    ssr: false,
    loading: () => <p role="status">กำลังโหลดตัวอ่าน PDF…</p>,
});

const PREVIEW_FETCH_TIMEOUT_MS = 20_000;

export type ContentGrant = {
    signedUrl: string;
    contentType: string;
    expiresInSeconds?: number;
    fileName?: string;
};
type PreviewContent =
    | { kind: "text"; text: string }
    | { kind: "image"; url: string }
    | { kind: "pdf"; bytes: Uint8Array<ArrayBuffer> }
    | { kind: "failure"; code: PreviewFailure };

export function SignedPreview({ grant, title, onRenew, onDownload, busy }: {
    grant: ContentGrant;
    title: string;
    onRenew: () => void;
    onDownload?: () => void;
    busy?: boolean;
}) {
    const [content, setContent] = useState<PreviewContent | null>(null);
    const fail = useCallback((code: PreviewFailure) => setContent({ kind: "failure", code }), []);
    useEffect(() => {
        const controller = new AbortController();
        let imageUrl: string | undefined;
        const expiresIn = grant.expiresInSeconds ?? PREVIEW_URL_TTL_SECONDS;
        const expiry = window.setTimeout(() => {
            controller.abort();
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            fail("expired");
        }, expiresIn * 1000);
        const timeout = window.setTimeout(() => {
            if (controller.signal.aborted) return;
            controller.abort();
            fail("timeout");
        }, PREVIEW_FETCH_TIMEOUT_MS);
        void loadPreviewContent(grant.signedUrl, grant.contentType, controller.signal).then(({ type, bytes }) => {
            if (controller.signal.aborted) return;
            if (type === "application/pdf") {
                setContent({ kind: "pdf", bytes });
            } else if (type === "text/plain") {
                setContent({ kind: "text", text: new TextDecoder().decode(bytes) });
            } else {
                imageUrl = URL.createObjectURL(new Blob([bytes], { type }));
                setContent({ kind: "image", url: imageUrl });
            }
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) fail(error instanceof PreviewError ? error.code : "unavailable");
        }).finally(() => clearTimeout(timeout));
        return () => {
            clearTimeout(expiry);
            clearTimeout(timeout);
            controller.abort();
            if (imageUrl) URL.revokeObjectURL(imageUrl);
        };
    }, [grant.signedUrl, grant.contentType, grant.expiresInSeconds, fail]);

    if (content?.kind === "failure")
        return (
            <Notice tone="warning">
                {previewFailureText[content.code]}
                <div className="preview-actions">
                    {["expired", "timeout", "unavailable"].includes(content.code) && (
                        <button type="button" className="secondary" disabled={busy} onClick={onRenew}>ขอ URL ดูตัวอย่างใหม่</button>
                    )}
                    {onDownload && (
                        <button type="button" className="secondary" disabled={busy} onClick={onDownload}>
                            <Download aria-hidden="true" /> ดาวน์โหลดไฟล์
                        </button>
                    )}
                </div>
            </Notice>
        );
    return (
        <div className="content-preview">
            <p className="muted">URL มีอายุ 5 นาที · การเปิดนี้ไม่ใช่หลักฐานการอ่านเอกสาร</p>
            {!content && <p role="status">กำลังเปิดตัวอย่าง…</p>}
            {content?.kind === "text" && <pre className="text-preview">{content.text}</pre>}
            {content?.kind === "image" && (
                <picture>
                    <img src={content.url} alt={`ตัวอย่าง ${title}`} onError={() => fail("unavailable")} />
                </picture>
            )}
            {content?.kind === "pdf" && <PdfPreview bytes={content.bytes} onError={fail} />}
            <button type="button" className="quiet" disabled={busy} onClick={onRenew}>
                <RefreshCw aria-hidden="true" /> ขอ URL ดูตัวอย่างใหม่
            </button>
        </div>
    );
}
export function FilePreview({
    api,
    path,
    title,
    autoOpen = false,
    onDenied,
    onDownload,
    downloadBusy,
}: {
    api: Api;
    path: string;
    title: string;
    autoOpen?: boolean;
    onDenied?: () => void;
    onDownload?: () => void;
    downloadBusy?: boolean;
}) {
    const [grant, setGrant] = useState<ContentGrant | null>(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const serial = useRef(0);
    const load = useCallback(async () => {
        const id = ++serial.current;
        setBusy(true);
        setError("");
        setGrant(null);
        try {
            const result = await api<ContentGrant>(path, {
                method: "POST",
                body: "{}",
            });
            if (id === serial.current) setGrant(result.data);
        } catch (cause) {
            if (id === serial.current) {
                setError(errorText(cause));
                if (isDenied(cause)) onDenied?.();
            }
        } finally {
            if (id === serial.current) setBusy(false);
        }
    }, [api, path, onDenied]);
    useEffect(() => {
        if (autoOpen) {
            const timer = setTimeout(() => void load(), 0);
            return () => {
                clearTimeout(timer);
                invalidateRequest(serial);
            };
        }
        return () => {
            invalidateRequest(serial);
        };
    }, [autoOpen, load]);
    return (
        <section className="preview-region" aria-label="ตัวอย่างเอกสาร">
            {error && <Notice tone="warning">{error}</Notice>}
            {grant ? (
                <SignedPreview key={grant.signedUrl} grant={grant} title={title} onRenew={() => void load()}
                    onDownload={onDownload} busy={downloadBusy} />
            ) : (
                <button className="secondary" disabled={busy} onClick={() => void load()}>
                    <Eye aria-hidden="true" />
                    {busy ? "กำลังเตรียมตัวอย่าง…" : error ? "ขอ URL ดูตัวอย่างใหม่" : "ดูตัวอย่าง"}
                </button>
            )}
        </section>
    );
}
