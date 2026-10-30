import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { canSeeFile } from "@/application/auth/folder-visibility";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";
import { SupabaseObjectStorage } from "@/infrastructure/storage/supabase-object-storage";
import { accessibleDepartmentIds } from "@/application/auth/department-authorization";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_URL_TTL_SECONDS = 300;
const PREVIEWABLE_CONTENT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "text/plain"]);

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
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
        if (!(await canSeeFile(application, fileId))) return errorResponse("file_not_found", "File was not found.", 404);

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
        }
        const ownerSubject = application.userId ? null : (body as { ownerSubject?: unknown }).ownerSubject;
        if (!application.userId && (typeof ownerSubject !== "string" || !ownerSubject.trim() || ownerSubject.trim().length > 255)) {
            return errorResponse("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
        }

        const file = await new PostgresFileRepository().findAvailableById(fileId, {
            tenantId: application.tenantId,
            applicationId: application.applicationId,
            ownerSubject: typeof ownerSubject === "string" ? ownerSubject.trim() : null,
            departmentIds: accessibleDepartmentIds(application),
            userId: application.userId,
            isTenantAdmin: application.isTenantAdmin,
        });
        if (!file) return errorResponse("file_not_found", "File was not found.", 404);
        if (!PREVIEWABLE_CONTENT_TYPES.has(file.contentType.toLowerCase())) {
            return errorResponse("preview_not_supported", "Preview is not supported for this file type.", 415);
        }

        const grant = await new SupabaseObjectStorage().createPreviewGrant(file.bucketId, file.objectKey, PREVIEW_URL_TTL_SECONDS);
        return Response.json(
            {
                data: {
                    fileId: file.id,
                    fileName: file.originalName,
                    contentType: file.contentType,
                    signedUrl: grant.signedUrl,
                    expiresInSeconds: grant.expiresInSeconds,
                },
            },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        const serviceError = error as { code?: string; message?: string };
        console.error("Could not create preview URL", {
            code: serviceError.code,
            message: serviceError.message ?? "Unknown preview URL error",
        });
        return errorResponse("service_unavailable", "Could not create a preview URL.", 503);
    }
}

export const POST = auditRoute("file.preview_url", "file", handlePOST, { recordSuccess: true, signedUrl: true });
