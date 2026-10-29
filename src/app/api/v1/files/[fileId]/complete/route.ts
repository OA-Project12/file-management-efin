import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { canSeeFile } from "@/application/auth/folder-visibility";
import { SupabaseObjectStorage } from "@/infrastructure/storage/supabase-object-storage";
import { PostgresUploadIntentRepository } from "@/infrastructure/database/postgres-upload-intent-repository";
import { departmentIdsForRole, hasDepartmentRole } from "@/application/auth/department-authorization";

const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

function getMaxUploadSizeBytes(): number {
    const configured = Number(process.env.MAX_UPLOAD_SIZE_BYTES ?? DEFAULT_MAX_UPLOAD_SIZE_BYTES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_SIZE_BYTES;
}

export async function POST(request: Request, context: { params: Promise<{ fileId: string }> }): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes("files:write")) {
            return errorResponse("forbidden", "The API key does not have files:write scope.", 403);
        }

        const { fileId } = await context.params;
        if (!UUID_PATTERN.test(fileId)) return errorResponse("invalid_file_id", "fileId must be a UUID.", 400);

        const repository = new PostgresUploadIntentRepository();
        const upload = await repository.findUpload(fileId, application.tenantId, application.applicationId);
        if (!upload) return errorResponse("file_not_found", "Upload intent was not found.", 404);
        if (!await canSeeFile(application, fileId)) return errorResponse("file_not_found", "Upload intent was not found.", 404);
        if (!hasDepartmentRole(application, upload.departmentId, "editor"))
            return errorResponse("department_forbidden", "Editor access to this department is required.", 403);
        if (upload.status === "available" && upload.completedAt) {
            return Response.json({ data: { fileId, status: "available" } }, { headers: { "Cache-Control": "no-store" } });
        }
        if (upload.status !== "pending_upload" || upload.completedAt) {
            return errorResponse("upload_not_pending", "This upload cannot be completed.", 409);
        }
        if (upload.expiresAt.getTime() <= Date.now()) {
            return errorResponse("upload_intent_expired", "The upload intent has expired.", 410);
        }

        const objectStorage = new SupabaseObjectStorage();
        const objectInfo = await objectStorage.getObjectInfo(upload.bucketId, upload.objectKey);
        if (!objectInfo) return errorResponse("object_not_found", "The uploaded object was not found.", 409);

        const actualContentType = objectInfo.contentType ?? upload.contentType;
        if (objectInfo.sizeBytes > getMaxUploadSizeBytes()) {
            await repository.quarantineUpload(fileId, application.tenantId, application.applicationId);
            await objectStorage.deleteObject(upload.bucketId, upload.objectKey).catch((error) => {
                console.error("Could not remove oversized uploaded object", {
                    message: error instanceof Error ? error.message : "Unknown storage error",
                });
            });
            return errorResponse("file_too_large", "Uploaded object exceeds the configured size limit.", 413);
        }

        const completed = await repository.completeUpload(
            fileId,
            application.tenantId,
            application.applicationId,
            departmentIdsForRole(application, "editor"),
            objectInfo.sizeBytes,
            actualContentType,
        );
        if (!completed) return errorResponse("upload_not_pending", "This upload is no longer pending.", 409);

        return Response.json(
            { data: { fileId, status: "available", sizeBytes: objectInfo.sizeBytes, contentType: actualContentType } },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        const serviceError = error as { code?: string; message?: string };
        console.error("Could not complete upload", {
            code: serviceError.code,
            message: serviceError.message ?? "Unknown upload completion error",
        });
        return errorResponse("service_unavailable", "Could not complete the upload.", 503);
    }
}
