import { auditRoute } from "@/infrastructure/audit/audit-route";
import { ListFiles } from "@/application/files/list-files";
import type { FilePagePosition } from "@/application/files/ports/file-repository";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";
import { accessibleDepartmentIds, hasDepartmentRole } from "@/application/auth/department-authorization";
import { createHash } from "node:crypto";
import { normalizeFileSearchQuery,InvalidFileSearchQuery } from "@/domain/files/file-search-query";

const MAX_REQUEST_BODY_BYTES = 4096;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ListFilesRequest {
    q?: unknown;
    ownerSubject?: unknown;
    limit?: unknown;
    cursor?: unknown;
    folderId?: unknown;
    departmentId?: unknown;
    tag?: unknown;
    contentType?: unknown;
    createdFrom?: unknown;
    createdTo?: unknown;
}

function parseBangkokDate(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000+07:00`);
    if (Number.isNaN(date.getTime())) return null;
    const bangkokDate = new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return bangkokDate !== value ? null : date.toISOString();
}

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readJsonBody(request: Request): Promise<ListFilesRequest | null> {
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
        return parsed as ListFilesRequest;
    } catch {
        return null;
    }
}

type SearchCursor=FilePagePosition&{searchFingerprint?:string};
function decodeCursor(value: unknown): SearchCursor | null | undefined {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;

    try {
        const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (!parsed || typeof parsed !== "object") return undefined;

        const cursor = parsed as { createdAt?: unknown; fileId?: unknown; searchFingerprint?:unknown };
        if (typeof cursor.createdAt !== "string" || typeof cursor.fileId !== "string" || !UUID_PATTERN.test(cursor.fileId)) {
            return undefined;
        }

        const createdAt = new Date(cursor.createdAt);
        if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== cursor.createdAt) return undefined;
        if(cursor.searchFingerprint!==undefined&&(typeof cursor.searchFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(cursor.searchFingerprint)))return undefined;
        return { createdAt, fileId: cursor.fileId,searchFingerprint:cursor.searchFingerprint as string|undefined };
    } catch {
        return undefined;
    }
}

function encodeCursor(position: SearchCursor): string {
    return Buffer.from(
        JSON.stringify({
            createdAt: position.createdAt.toISOString(),
            fileId: position.fileId,
            ...(position.searchFingerprint?{searchFingerprint:position.searchFingerprint}:{}),
        }),
    ).toString("base64url");
}

async function handlePOST(request: Request): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes("files:read")) {
            return errorResponse("forbidden", "The API key does not have files:read scope.", 403);
        }

        let body: ListFilesRequest;
        try {
            const parsed = await readJsonBody(request);
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

        const limit = body.limit === undefined ? DEFAULT_PAGE_SIZE : body.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
            return errorResponse("invalid_limit", `limit must be an integer from 1 to ${MAX_PAGE_SIZE}.`, 400);
        }

        const cursor = decodeCursor(body.cursor);
        if (cursor === undefined) return errorResponse("invalid_cursor", "cursor is invalid.", 400);
        let q:string;
        try{q=normalizeFileSearchQuery(body.q);}catch(error){
            if(error instanceof InvalidFileSearchQuery)return errorResponse('invalid_search_query','q must be a string up to 200 characters and 10 whitespace-separated words.',400);
            throw error;
        }
        const folderId = body.folderId === undefined || body.folderId === null || body.folderId === "" ? undefined : body.folderId;
        if (folderId !== undefined && (typeof folderId !== "string" || !UUID_PATTERN.test(folderId))) {
            return errorResponse("invalid_folder_id", "folderId must be a UUID.", 400);
        }
        const departmentId =
            body.departmentId === undefined || body.departmentId === null || body.departmentId === "" ? undefined : body.departmentId;
        if (departmentId !== undefined && (typeof departmentId !== "string" || !UUID_PATTERN.test(departmentId))) {
            return errorResponse("invalid_department_id", "departmentId must be a UUID.", 400);
        }
        if (typeof departmentId === "string" && !hasDepartmentRole(application, departmentId, "viewer")) {
            return errorResponse("department_forbidden", "The API key has no access to this department.", 403);
        }
        const tag = body.tag === undefined || body.tag === null || body.tag === "" ? undefined : body.tag;
        if (tag !== undefined && (typeof tag !== "string" || tag.trim().length > 64)) {
            return errorResponse("invalid_tag", "tag must be a string up to 64 characters.", 400);
        }
        const contentType =
            body.contentType === undefined || body.contentType === null || body.contentType === "" ? undefined : body.contentType;
        if (
            contentType !== undefined &&
            (typeof contentType !== "string" || contentType.length > 255 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType))
        ) {
            return errorResponse("invalid_content_type", "contentType must be a valid MIME type.", 400);
        }
        const createdFrom = parseBangkokDate(body.createdFrom);
        const createdTo = parseBangkokDate(body.createdTo);
        if (createdFrom === null || createdTo === null || (createdFrom && createdTo && createdFrom > createdTo)) {
            return errorResponse(
                "invalid_date_range",
                "createdFrom and createdTo must be valid YYYY-MM-DD dates in Asia/Bangkok, with createdFrom on or before createdTo.",
                400,
            );
        }
        const createdBefore = createdTo ? new Date(Date.parse(createdTo) + 86_400_000).toISOString() : undefined;
        const searchFingerprint=q?createHash('sha256').update(JSON.stringify([
            application.tenantId,application.applicationId,ownerSubject,[application.userId?'user':'api_key',application.userId??application.keyId],Boolean(application.isTenantAdmin),
            accessibleDepartmentIds(application).sort(),q,folderId??null,departmentId??null,typeof tag==='string'?tag.trim():null,
            typeof contentType==='string'?contentType.toLowerCase():null,createdFrom??null,createdBefore??null,
        ])).digest('hex'):undefined;
        if(cursor&&cursor.searchFingerprint!==searchFingerprint)return errorResponse('invalid_cursor','cursor does not match the search criteria. Start from the first page.',400);

        const listFiles = new ListFiles(new PostgresFileRepository());
        const rows = await listFiles.execute(
            {
                tenantId: application.tenantId,
                applicationId: application.applicationId,
                ownerSubject,
                departmentIds: accessibleDepartmentIds(application),
                userId: application.userId,
                isTenantAdmin: application.isTenantAdmin,
            },
            limit + 1,
            cursor ?? undefined,
            {
                q:q||undefined,
                folderId: folderId as string | undefined,
                departmentId: typeof departmentId === "string" ? departmentId : undefined,
                tag: typeof tag === "string" ? tag.trim() : undefined,
                contentType: typeof contentType === "string" ? contentType.toLowerCase() : undefined,
                createdFrom,
                createdBefore,
            },
        );

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const last = items.at(-1);
        const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.createdAt, fileId: last.id,searchFingerprint }) : null;

        return Response.json({ data: { items, nextCursor } }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        const serviceError = error as { code?: string; message?: string };
        console.error("Could not list files", {
            code: serviceError.code,
            message: serviceError.message ?? "Unknown file listing error",
        });
        return errorResponse("service_unavailable", "Could not list files.", 503);
    }
}

export const POST = auditRoute("file.search", "file", handlePOST, { recordSuccess: false, signedUrl: false });
