import { auditRoute } from "@/infrastructure/audit/audit-route";
import { CreateFileDownloadGrant } from "@/application/files/create-file-download-grant";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { canSeeFile } from "@/application/auth/folder-visibility";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";
import { SupabaseObjectStorage } from "@/infrastructure/storage/supabase-object-storage";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DownloadUrlRequest {
    ownerSubject?: unknown;
}

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readRequestBody(request: Request): Promise<DownloadUrlRequest | null> {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > 2048) {
            await reader.cancel();
            throw new RangeError("request_body_too_large");
        }
        chunks.push(value);
    }

    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as DownloadUrlRequest;
    } catch {
        return null;
    }
}

async function handlePOST(request: Request, context: { params: Promise<{ fileId: string }> }): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes("files:read")) {
            return errorResponse("forbidden", "The API key does not have files:read scope.", 403);
        }

        const { fileId } = await context.params;
        if (!UUID_PATTERN.test(fileId)) return errorResponse("invalid_file_id", "fileId must be a UUID.", 400);
        if (!await canSeeFile(application, fileId)) return errorResponse("file_not_found", "File was not found.", 404);

        let body: DownloadUrlRequest;
        try {
            const parsed = await readRequestBody(request);
            if (!parsed) throw new Error("invalid_json");
            body = parsed;
        } catch (error) {
            if (error instanceof RangeError) return errorResponse("request_too_large", "Request body is too large.", 413);
            return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
        }

        const ownerSubject = application.userId ? null : typeof body.ownerSubject === "string" ? body.ownerSubject.trim() : "";
        if (!application.userId && (!ownerSubject || ownerSubject.length > 255)) {
            return errorResponse("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
        }

        const useCase = new CreateFileDownloadGrant(new PostgresFileRepository(), new SupabaseObjectStorage());
        const grant = await useCase.execute({ fileId, ownerSubject, application });
        if (!grant) return errorResponse("file_not_found", "File was not found.", 404);

        return Response.json({ data: grant }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        const serviceError = error as { code?: string; message?: string };
        console.error("Could not create download URL", {
            code: serviceError.code,
            message: serviceError.message ?? "Unknown download URL error",
        });
        return errorResponse("service_unavailable", "Could not create a download URL.", 503);
    }
}

export const POST = auditRoute("file.download_url", "file", handlePOST, { recordSuccess: true, signedUrl: true });
