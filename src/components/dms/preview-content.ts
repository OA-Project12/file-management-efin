import { previewMediaType } from "@/domain/files/preview-policy";

const BINARY_LIMIT = 25 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

export const previewFailureText = {
    expired: "URL ดูตัวอย่างหมดอายุแล้ว",
    unsupported: "ไฟล์ชนิดนี้ดูตัวอย่างไม่ได้",
    invalid_url: "ลิงก์ดูตัวอย่างไม่ได้มาจาก Storage ที่กำหนด",
    type_mismatch: "ชนิดไฟล์ที่ Storage ส่งมาไม่ตรงกับข้อมูลเอกสาร",
    too_large: "ไฟล์เกินขนาดที่เปิดดูตัวอย่างได้",
    timeout: "ใช้เวลาดึงไฟล์นานเกินไป",
    unavailable: "เปิดตัวอย่างไม่ได้",
    pdf_failed: "อ่านไฟล์ PDF นี้ไม่ได้",
    pdf_password: "PDF นี้ต้องใช้รหัสผ่านเพื่อเปิด",
} as const;

export type PreviewFailure = keyof typeof previewFailureText;

export class PreviewError extends Error {
    constructor(readonly code: PreviewFailure) {
        super(code);
    }
}

export async function loadPreviewContent(signedUrl: string, declaredType: string, signal: AbortSignal) {
    const type = previewMediaType(declaredType);
    if (!type) throw new PreviewError("unsupported");

    let url: URL;
    let origin: string;
    try {
        url = new URL(signedUrl);
        origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
    } catch {
        throw new PreviewError("invalid_url");
    }
    if (
        url.origin !== origin ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !url.pathname.startsWith("/storage/v1/object/sign/")
    ) {
        throw new PreviewError("invalid_url");
    }

    const response = await fetch(url, {
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal,
    });
    const limit = type === "text/plain" ? TEXT_LIMIT : BINARY_LIMIT;
    try {
        if (!response.ok || !response.body) throw new PreviewError("unavailable");
        const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim();
        if (!contentType || previewMediaType(contentType) !== type) throw new PreviewError("type_mismatch");
        if (Number(response.headers.get("Content-Length")) > limit) throw new PreviewError("too_large");
    } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new PreviewError("too_large");
            chunks.push(value);
        }
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { type, bytes };
}
