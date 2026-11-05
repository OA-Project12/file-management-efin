import { FILE_PREFIX_BYTES, FileValidationError } from "@/domain/files/file-validation";

// Keep the deadline alive through body consumption, not just until headers arrive.
export async function readObjectPrefix(bucket: string, key: string, timeoutMs = 15_000, eTag?: string): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const origin = new URL(process.env.SUPABASE_URL!);
        const secret = process.env.SUPABASE_SECRET_KEY;
        if (!secret || !["https:", "http:"].includes(origin.protocol) || origin.username || origin.password ||
            [bucket, ...key.split("/")].some(p => !p || p === "." || p === "..")) throw new Error();
        const path = [bucket, ...key.split("/")].map(encodeURIComponent).join("/");
        const url = new URL(`/storage/v1/object/authenticated/${path}`, origin.origin);
        const response = await fetch(url, { headers: { apikey: secret, Authorization: `Bearer ${secret}`, Range: `bytes=0-${FILE_PREFIX_BYTES - 1}`, ...(eTag ? { "If-Match": eTag } : {}) },
            signal: controller.signal, redirect: "error", cache: "no-store" });
        if (response.status === 412) throw new FileValidationError("object_changed");
        if (![200,206].includes(response.status) || !response.body) throw new Error();
        if (response.status === 206 && !/^bytes 0-\d+\/\d+$/.test(response.headers.get("content-range") ?? "")) throw new Error();
        reader = response.body.getReader();
        const result = new Uint8Array(FILE_PREFIX_BYTES);
        let length = 0;
        // Race only read-only I/O; abort also terminates the underlying request.
        const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new FileValidationError("file_validation_unavailable")), { once: true }));
        while (length < result.length) {
            const part = await Promise.race([reader.read(), aborted]);
            if (part.done) break;
            const take = Math.min(part.value.byteLength, result.length - length);
            result.set(part.value.subarray(0, take), length); length += take;
        }
        return result.slice(0, length);
    } catch (error) {
        if (error instanceof FileValidationError) throw error;
        throw new FileValidationError("file_validation_unavailable");
    } finally {
        if (reader) void reader.cancel().catch(() => undefined);
        controller.abort(); clearTimeout(timer);
    }
}
