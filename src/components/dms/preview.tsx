"use client";
import { invalidateRequest } from "@/components/dms/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, RefreshCw } from "lucide-react";
import type { Api } from "./model";
import { errorText, isDenied } from "./model";
import { Notice } from "./common";

export type ContentGrant = {
    signedUrl: string;
    contentType: string;
    expiresInSeconds?: number;
    fileName?: string;
};
export function SignedPreview({ grant, title, onRenew }: { grant: ContentGrant; title: string; onRenew: () => void }) {
    const [expired, setExpired] = useState(false),
        [text, setText] = useState<string | null>(null),
        [error, setError] = useState("");
    useEffect(() => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => setExpired(true), (grant.expiresInSeconds ?? 300) * 1000);
        if (grant.contentType === "text/plain")
            void fetch(grant.signedUrl, {
                signal: controller.signal,
                referrerPolicy: "no-referrer",
            })
                .then((response) => {
                    if (!response.ok) throw new Error();
                    return response.text();
                })
                .then(setText)
                .catch(() => {
                    if (!controller.signal.aborted) setError("เปิดตัวอย่างไม่ได้ กรุณาขอ URL ใหม่");
                });
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [grant.signedUrl, grant.contentType, grant.expiresInSeconds]);
    if (expired || error)
        return (
            <Notice tone="warning">
                {error || "URL ดูตัวอย่างหมดอายุแล้ว"}
                <button className="secondary" onClick={onRenew}>
                    ขอ URL ดูตัวอย่างใหม่
                </button>
            </Notice>
        );
    return (
        <div className="content-preview">
            <p className="muted">URL มีอายุ 5 นาที · การเปิดนี้ไม่ใช่หลักฐานการอ่านเอกสาร</p>
            {grant.contentType === "text/plain" ? (
                text === null ? (
                    <p role="status">กำลังเปิดข้อความ…</p>
                ) : (
                    <pre className="text-preview">{text}</pre>
                )
            ) : grant.contentType.startsWith("image/") ? (
                <picture>
                    <img
                        src={grant.signedUrl}
                        alt={`ตัวอย่าง ${title}`}
                        referrerPolicy="no-referrer"
                        onError={() => setError("เปิดตัวอย่างไม่ได้ กรุณาขอ URL ใหม่")}
                    />
                </picture>
            ) : (
                <iframe src={grant.signedUrl} title={`ตัวอย่าง ${title}`} referrerPolicy="no-referrer" />
            )}
            <button className="quiet" onClick={onRenew}>
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
}: {
    api: Api;
    path: string;
    title: string;
    autoOpen?: boolean;
    onDenied?: () => void;
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
                <SignedPreview key={grant.signedUrl} grant={grant} title={title} onRenew={() => void load()} />
            ) : (
                <button className="secondary" disabled={busy} onClick={() => void load()}>
                    <Eye aria-hidden="true" />
                    {busy ? "กำลังเตรียมตัวอย่าง…" : error ? "ขอ URL ดูตัวอย่างใหม่" : "ดูตัวอย่าง"}
                </button>
            )}
        </section>
    );
}
