import { auditRoute } from "@/infrastructure/audit/audit-route";
import { RequestFileDeletion } from "@/application/files/request-file-deletion";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { canSeeFile } from "@/application/auth/folder-visibility";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";
import { departmentIdsForRole } from "@/application/auth/department-authorization";

const MAX_REQUEST_BODY_BYTES = 2048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DeleteFileRequest {
    ownerSubject?: unknown;
}

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readRequestBody(request: Request): Promise<DeleteFileRequest | null> {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_REQUEST_BODY_BYTES) {
            await reader.cancel();
            throw new RangeError("request_body_too_large");
        }
        chunks.push(value);
    }

    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as DeleteFileRequest;
    } catch {
        return null;
    }
}

async function handlePOST(request: Request, context: { params: Promise<{ fileId: string }> }): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes("files:write")) {
            return errorResponse("forbidden", "The API key does not have files:write scope.", 403);
        }

        const { fileId } = await context.params;
        if (!UUID_PATTERN.test(fileId)) return errorResponse("invalid_file_id", "fileId must be a UUID.", 400);
        if (!(await canSeeFile(application, fileId))) return errorResponse("file_not_found", "File was not found.", 404);

        let body: DeleteFileRequest;
        try {
            const parsed = await readRequestBody(request);
            if (!parsed) throw new Error("invalid_json");
            body = parsed;
        } catch (error) {
            if (error instanceof RangeError) return errorResponse("request_too_large", "Request body is too large.", 413);
            return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
        }

        const ownerSubject = application.userId ? null : typeof body.ownerSubject === "string" ? body.ownerSubject.trim() : "";
        if (!application.userId && (!ownerSubject || ownerSubject.length > 255)) {
            return errorResponse("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
        }

        const useCase = new RequestFileDeletion(new PostgresFileRepository());
        const result = await useCase.execute(fileId, {
      auditActor: application,
            tenantId: application.tenantId,
            applicationId: application.applicationId,
            ownerSubject,
            departmentIds: departmentIdsForRole(application, "editor"),
        });

        if (result === "not_found") return errorResponse("file_not_found", "File was not found.", 404);
        if (result === "not_deletable") return errorResponse("file_not_deletable", "File is not in a deletable state.", 409);

        return Response.json(
            { data: { fileId, status: "deleted", trashed: true } },
            { status: 200, headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        const serviceError = error as { code?: string; message?: string };
        console.error("Could not request file deletion", {
            code: serviceError.code,
            message: serviceError.message ?? "Unknown file deletion error",
        });
        return errorResponse("service_unavailable", "Could not request file deletion.", 503);
    }
}

export const POST = auditRoute("file.trash", "file", handlePOST, { recordSuccess: false, signedUrl: false });
