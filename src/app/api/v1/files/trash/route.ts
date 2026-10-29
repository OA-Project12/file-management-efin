import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { accessibleDepartmentIds, hasDepartmentRole } from "@/application/auth/department-authorization";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";
import type { TrashPagePosition } from "@/application/files/ports/file-repository";
import { connection } from "next/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

function decodeCursor(value: string | null): TrashPagePosition | null | undefined {
    if (!value) return null;
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
    try {
        const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (!parsed || typeof parsed !== "object") return undefined;
        const cursor = parsed as { trashedAt?: unknown; fileId?: unknown };
        if (typeof cursor.trashedAt !== "string" || typeof cursor.fileId !== "string" || !UUID_PATTERN.test(cursor.fileId))
            return undefined;
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.trashedAt) || !Number.isFinite(Date.parse(cursor.trashedAt)))
            return undefined;
        return { trashedAt: cursor.trashedAt, fileId: cursor.fileId };
    } catch {
        return undefined;
    }
}

export async function GET(request: Request): Promise<Response> {
    await connection();
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return fail("unauthorized", "A valid API key is required.", 401);
        if (!app.scopes.includes("files:read")) return fail("forbidden", "files:read scope is required.", 403);
        const query = new URL(request.url).searchParams;
        const ownerSubject = app.userId ? null : query.get("ownerSubject")?.trim() ?? "";
        const departmentId = query.get("departmentId") || undefined;
        if (!app.userId && (!ownerSubject || ownerSubject.length > 255))
            return fail("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
        if (departmentId && !UUID_PATTERN.test(departmentId)) return fail("invalid_department_id", "departmentId must be a UUID.", 400);
        if (departmentId && !hasDepartmentRole(app, departmentId, "viewer"))
            return fail("department_forbidden", "The API key has no access to this department.", 403);
        const limitText = query.get("limit");
        const limit = limitText === null ? 25 : Number(limitText);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            return fail("invalid_limit", "limit must be an integer from 1 to 100.", 400);
        const cursor = decodeCursor(query.get("cursor"));
        if (cursor === undefined) return fail("invalid_cursor", "cursor is invalid.", 400);
        const rows = await new PostgresFileRepository().listTrash(
            {
                tenantId: app.tenantId,
                applicationId: app.applicationId,
                ownerSubject,
                departmentIds: accessibleDepartmentIds(app),
                userId: app.userId,
                isTenantAdmin: app.isTenantAdmin,
            },
            limit + 1,
            cursor ?? undefined,
            departmentId,
        );
        const hasMore = rows.length > limit;
        const selectedRows = hasMore ? rows.slice(0, limit) : rows;
        const last = selectedRows.at(-1);
        const items = selectedRows.map((row) => {
            const item = { ...row };
            delete item.trashedAtCursor;
            return item;
        });
        const nextCursor =
            hasMore && last?.trashedAtCursor
                ? Buffer.from(JSON.stringify({ trashedAt: last.trashedAtCursor, fileId: last.id })).toString("base64url")
                : null;
        return Response.json({ data: { items, nextCursor } }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.error("Could not list trash", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not list trash.", 503);
    }
}
