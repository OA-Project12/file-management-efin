import { logger } from "@/infrastructure/security/logger.mjs";
import "server-only";
import { randomUUID } from "node:crypto";
import { connection } from "next/server";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresFileVersionRepository, VersionError, type VersionScope } from "@/infrastructure/database/postgres-file-version-repository";
import { SupabaseObjectStorage } from "@/infrastructure/storage/supabase-object-storage";
import { recordAudit } from "@/infrastructure/audit/record-audit";
import { storageQuotaErrorResponse } from "./storage-quota-errors";
import { StorageQuotaError } from "@/domain/storage/department-quota";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Context = { params: Promise<{ fileId: string; versionId?: string }> };
const repository = new PostgresFileVersionRepository();
const storage = new SupabaseObjectStorage();
const json = (data: unknown, status = 200) => Response.json({ data }, { status, headers: { "Cache-Control": "no-store" } });
const maxSize = () => {
    const value = Number(process.env.MAX_UPLOAD_SIZE_BYTES ?? 26214400);
    return Number.isSafeInteger(value) && value > 0 ? value : 26214400;
};

async function body(request: Request): Promise<Record<string, unknown>> {
    if (!request.body) throw new VersionError("invalid_json", 400);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 16384) {
            await reader.cancel();
            throw new VersionError("request_too_large", 413);
        }
        chunks.push(part.value);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value;
    } catch {
        throw new VersionError("invalid_json", 400);
    }
}

async function scope(request: Request, owner: unknown, write: boolean, refresh = false): Promise<VersionScope> {
    const app = await authenticateApplicationKey(request, refresh);
    if (!app) throw new VersionError("unauthorized", 401);
    if (!app.scopes.includes(write ? "files:write" : "files:read")) throw new VersionError("forbidden", 403);
    const ownerSubject = app.userId ? null : typeof owner === "string" ? owner.trim() : "";
    if (!app.userId && (!ownerSubject || ownerSubject.length > 255)) throw new VersionError("invalid_owner_subject", 400);
    return { app, ownerSubject };
}

function failure(error: unknown) {
    const quota = storageQuotaErrorResponse(error);
    if (quota) return quota;
    const known = error instanceof VersionError;
    if (!known) logger.error("File version operation failed", { message: error instanceof Error ? error.message : "Unknown error" });
    const code = known ? error.code : "service_unavailable";
    const message =
        code === "version_conflict"
            ? "Current version changed. Reload the file before trying again."
            : code === "service_unavailable"
              ? "File version service is temporarily unavailable."
              : code.replaceAll("_", " ");
    return Response.json({ error: { code, message } }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}

export async function listVersions(request: Request, context: Context) {
    await connection();
    try {
        const { fileId } = await context.params;
        if (!UUID.test(fileId)) throw new VersionError("invalid_file_id", 400);
        const query = new URL(request.url).searchParams;
        const auth = await scope(request, query.get("ownerSubject"), false);
        const limit = Number(query.get("limit") ?? 25);
        const cursor = query.get("cursor");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new VersionError("invalid_limit", 400);
        if (cursor !== null && (!/^\d{1,10}$/.test(cursor) || Number(cursor) < 1 || Number(cursor) > 2147483647))
            throw new VersionError("invalid_cursor", 400);
        return json(await repository.list(fileId, auth, limit, cursor === null ? null : Number(cursor)));
    } catch (error) {
        return failure(error);
    }
}

export async function createVersionUpload(request: Request, context: Context) {
    try {
        const { fileId } = await context.params;
        if (!UUID.test(fileId)) throw new VersionError("invalid_file_id", 400);
        const input = await body(request);
        const auth = await scope(request, input.ownerSubject, true);
        if (typeof input.expectedCurrentVersionId !== "string" || !UUID.test(input.expectedCurrentVersionId))
            throw new VersionError("invalid_current_version_id", 400);
        const name =
            typeof input.originalName === "string"
                ? input.originalName
                      .replace(/[\\/]/g, "_")
                      .replace(/[\u0000-\u001f\u007f]/g, "")
                      .trim()
                : "";
        if (!name || name.length > 1024) throw new VersionError("invalid_file_name", 400);
        const contentType = typeof input.contentType === "string" ? input.contentType.trim() : "";
        if (!contentType || contentType.length > 255 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType))
            throw new VersionError("invalid_content_type", 400);
        if (typeof input.sizeBytes !== "number" || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1)
            throw new VersionError("invalid_size", 400);
        if (input.sizeBytes > maxSize()) throw new VersionError("file_too_large", 413);
        const checksum = input.checksumSha256;
        if (checksum != null && (typeof checksum !== "string" || !/^[a-f0-9]{64}$/i.test(checksum)))
            throw new VersionError("invalid_checksum", 400);
        const versionId = randomUUID();
        const objectKey = `${auth.app.tenantId}/${auth.app.applicationId}/${fileId}/versions/${versionId}`;
        const grant = await storage.createUploadGrant(objectKey);
        const result = await repository.create(fileId, auth, {
            versionId,
            expectedCurrentVersionId: input.expectedCurrentVersionId,
            bucketId: grant.bucket,
            objectKey,
            originalName: name,
            contentType,
            sizeBytes: input.sizeBytes,
            checksumSha256: typeof checksum === "string" ? checksum.toLowerCase() : null,
        });
        return json(
            { fileId, versionId, ...result, bucketId: grant.bucket, objectKey, signedUrl: grant.signedUrl, uploadToken: grant.token },
            201,
        );
    } catch (error) {
        return failure(error);
    }
}

export async function completeVersionUpload(request: Request, context: Context) {
    try {
        const { fileId, versionId } = await context.params;
        if (!UUID.test(fileId) || !versionId || !UUID.test(versionId)) throw new VersionError("invalid_version_id", 400);
        const input = await body(request);
        const auth = await scope(request, input.ownerSubject, true);
        const v = await repository.find(fileId, versionId, auth);
        if (v.completed_at && v.status === "available") return json({ fileId, versionId, status: "available" });
        if (v.status !== "pending_upload") throw new VersionError("upload_not_pending", 409);
        if (v.expires_at.getTime() <= Date.now()) throw new VersionError("upload_intent_expired", 410);
        const info = await storage.getObjectInfo(v.bucket_id, v.object_key);
        if (!info) throw new VersionError("object_not_found", 409);
        const oversized = info.sizeBytes > maxSize();
        const rejected = await repository.complete(fileId, versionId, auth, info.sizeBytes, info.contentType ?? v.content_type, oversized);
        if (rejected) {
            await storage.deleteObject(v.bucket_id, v.object_key).catch(() => undefined);
            if (rejected === "file_too_large") throw new VersionError(rejected, 413);
            throw new StorageQuotaError(rejected);
        }
        return json({ fileId, versionId, status: "available", sizeBytes: info.sizeBytes, contentType: info.contentType ?? v.content_type });
    } catch (error) {
        return failure(error);
    }
}

const PREVIEWABLE = new Set(["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp", "text/plain"]);

async function versionIds(context: Context) {
    const { fileId, versionId } = await context.params;
    if (!UUID.test(fileId)) throw new VersionError("invalid_file_id", 400);
    if (!versionId || !UUID.test(versionId)) throw new VersionError("invalid_version_id", 400);
    return { fileId, versionId };
}

async function versionUrl(request: Request, context: Context, preview: boolean) {
    try {
        const { fileId, versionId } = await versionIds(context);
        const input = await body(request);
        const auth = await scope(request, input.ownerSubject, false);
        const v = await repository.findAvailable(fileId, versionId, auth);
        const info = await storage.getObjectInfo(v.bucket_id, v.object_key);
        if (!info) throw new VersionError("object_not_found", 409);
        if (info.sizeBytes !== Number(v.size_bytes)) throw new VersionError("object_changed", 409);
        const contentType = info.contentType ?? v.content_type;
        if (preview && !PREVIEWABLE.has(contentType.toLowerCase())) throw new VersionError("preview_not_supported", 415);
        const grant = preview
            ? await storage.createPreviewGrant(v.bucket_id, v.object_key, 300)
            : await storage.createDownloadGrant(v.bucket_id, v.object_key, 300, v.original_name);
        // Fail closed: never return the signed URL unless its audit event was persisted.
        try {
            await recordAudit(auth.app, {
                action: preview ? "file.version_preview_url" : "file.version_download_url",
                outcome: "success",
                resourceType: "file",
                resourceId: fileId,
                details: { versionId, versionNumber: v.version_number },
            });
        } catch {
            throw new VersionError("audit_unavailable", 503);
        }
        return json({
            fileId,
            versionId,
            versionNumber: v.version_number,
            fileName: v.original_name,
            contentType,
            sizeBytes: v.size_bytes,
            ...grant,
        });
    } catch (error) {
        return failure(error);
    }
}

export const previewVersion = (request: Request, context: Context) => versionUrl(request, context, true);
export const downloadVersion = (request: Request, context: Context) => versionUrl(request, context, false);

export async function restoreVersion(request: Request, context: Context) {
    let pending: { fileId: string; versionId: string; auth: VersionScope; bucketId: string; objectKey: string } | undefined;
    try {
        const { fileId, versionId: sourceVersionId } = await versionIds(context);
        const input = await body(request);
        const auth = await scope(request, input.ownerSubject, true);
        if (typeof input.expectedCurrentVersionId !== "string" || !UUID.test(input.expectedCurrentVersionId))
            throw new VersionError("invalid_current_version_id", 400);
        const source = await repository.findAvailable(fileId, sourceVersionId, auth, true);
        const info = await storage.getObjectInfo(source.bucket_id, source.object_key);
        if (!info) throw new VersionError("object_not_found", 409);
        if (info.sizeBytes !== Number(source.size_bytes)) throw new VersionError("object_changed", 409);
        if (info.sizeBytes > maxSize()) throw new VersionError("file_too_large", 413);
        const versionId = randomUUID();
        const objectKey = `${auth.app.tenantId}/${auth.app.applicationId}/${fileId}/versions/${versionId}`;
        const contentType = info.contentType ?? source.content_type;
        const reserved = await repository.reserveRestore(fileId, sourceVersionId, auth, {
            versionId,
            expectedCurrentVersionId: input.expectedCurrentVersionId,
            objectKey,
            sizeBytes: info.sizeBytes,
            contentType,
        });
        pending = { fileId, versionId, auth, bucketId: reserved.bucketId, objectKey };
        await storage.copyObject(reserved.bucketId, source.object_key, objectKey);
        const copied = await storage.getObjectInfo(reserved.bucketId, objectKey);
        if (!copied || copied.sizeBytes !== info.sizeBytes || (copied.contentType ?? contentType) !== contentType)
            throw new VersionError("object_changed", 409);
        // A restore can spend time copying; refresh membership/key validity before publishing it.
        const latestAuth = await scope(request, input.ownerSubject, true, true);
        const rejected = await repository.completeRestore(fileId, versionId, latestAuth);
        if (rejected) throw new StorageQuotaError(rejected);
        return json(
            {
                fileId,
                versionId,
                currentVersionId: versionId,
                restoredFromVersionId: sourceVersionId,
                versionNumber: reserved.versionNumber,
                status: "available",
                sizeBytes: copied.sizeBytes,
                contentType,
            },
            201,
        );
    } catch (error) {
        if (pending) {
            const { fileId, versionId, auth, bucketId, objectKey } = pending;
            try {
                const safeToRemove = await repository.failRestore(
                    fileId,
                    versionId,
                    auth,
                    error instanceof VersionError ? error.code : "storage_or_database_failure",
                );
                if (safeToRemove) await storage.deleteObject(bucketId, objectKey);
            } catch {
                // Keep the tracked pending/failed row for cleanup; never risk removing a committed current object.
                logger.error("Restore copy needs cleanup", { fileId, versionId });
            }
        }
        return failure(error);
    }
}
