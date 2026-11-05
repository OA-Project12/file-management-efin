export const FILE_VALIDATION_POLICY = "signature-v1";
export const FILE_PREFIX_BYTES = 1024;
export const FILE_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
const mimeByExtension: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };
export type FileValidationCode = "file_type_not_allowed" | "file_signature_invalid" | "file_type_mismatch" | "file_validation_unavailable" | "object_changed";
export class FileValidationError extends Error {
    readonly status: number;
    constructor(readonly code: FileValidationCode, readonly detectedMime: string | null = null) {
        super(code);
        this.status = code === "file_validation_unavailable" ? 503 : code === "object_changed" ? 409 : 415;
    }
}
export function filenameMime(name: string): string | null {
    return mimeByExtension[name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}
export function validateDeclaredType(name: string, mime: string): string {
    const expected = filenameMime(name), normalized = mime.trim().toLowerCase();
    if (!expected || !Object.values(mimeByExtension).includes(normalized)) throw new FileValidationError("file_type_not_allowed");
    if (expected !== normalized) throw new FileValidationError("file_type_mismatch");
    return normalized;
}
export function browserUploadMime(file: { name: string; type: string }): string {
    return validateDeclaredType(file.name, file.type || filenameMime(file.name) || "");
}
export function detectSignature(bytes: Uint8Array): string | null {
    const matches = (signature: number[]) => bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);
    if (matches([0x25,0x50,0x44,0x46,0x2d])) return "application/pdf";
    if (matches([0xff,0xd8,0xff])) return "image/jpeg";
    if (matches([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) return "image/png";
    return null;
}
export function validateFilePrefix(name: string, declaredMime: string, storageMime: string | null, bytes: Uint8Array): string {
    const detected = detectSignature(bytes);
    if (!detected) throw new FileValidationError("file_signature_invalid");
    try { validateDeclaredType(name, declaredMime); }
    catch (error) { if (error instanceof FileValidationError) throw new FileValidationError(error.code, detected); throw error; }
    if (detected !== declaredMime.trim().toLowerCase() || detected !== storageMime?.trim().toLowerCase())
        throw new FileValidationError("file_type_mismatch", detected);
    return detected;
}
export function validationAudit(declaredMime: string, detectedMime: string | null) {
    return { validationPolicy: FILE_VALIDATION_POLICY, declaredMime, detectedMime };
}
