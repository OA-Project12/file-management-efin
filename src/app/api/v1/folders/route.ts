import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresFolderRepository } from "@/infrastructure/database/postgres-folder-repository";
import { hasDepartmentRole } from "@/application/auth/department-authorization";
import { canSeeFolder } from "@/application/auth/folder-visibility";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request): Promise<{ name?: unknown; parentFolderId?: unknown; departmentId?: unknown } | null> {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            throw new RangeError("too_large");
        }
        chunks.push(value);
    }
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as { name?: unknown; parentFolderId?: unknown; departmentId?: unknown })
            : null;
    } catch {
        return null;
    }
}

export async function GET(request: Request): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!app.scopes.includes("files:read")) return errorResponse("forbidden", "The API key does not have files:read scope.", 403);
        const search = new URL(request.url).searchParams;
        const departmentId = search.get("departmentId");
        if (!departmentId || !UUID_PATTERN.test(departmentId))
            return errorResponse("invalid_department_id", "departmentId must be a UUID.", 400);
        if (!hasDepartmentRole(app, departmentId, "viewer"))
            return errorResponse("department_forbidden", "The API key has no access to this department.", 403);
        const value = search.get("parentFolderId");
        if (value && !UUID_PATTERN.test(value)) return errorResponse("invalid_parent_folder_id", "parentFolderId must be a UUID.", 400);
        if (value && !(await canSeeFolder(app, departmentId, value)))
            return errorResponse("folder_not_found", "Folder was not found.", 404);
        const items = await new PostgresFolderRepository().list(
            app.tenantId,
            app.applicationId,
            departmentId,
            value,
            app.userId,
            app.isTenantAdmin,
        );
        return Response.json({ data: { items } }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.error("Could not list folders", { message: error instanceof Error ? error.message : "Unknown error" });
        return errorResponse("service_unavailable", "Could not list folders.", 503);
    }
}

export async function POST(request: Request): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!app.scopes.includes("files:write")) return errorResponse("forbidden", "The API key does not have files:write scope.", 403);
        let body;
        try {
            body = await readBody(request);
            if (!body) return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
        } catch (error) {
            if (error instanceof RangeError) return errorResponse("request_too_large", "Request body is too large.", 413);
            return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
        }
        const departmentId = typeof body.departmentId === "string" ? body.departmentId : "";
        if (!UUID_PATTERN.test(departmentId)) return errorResponse("invalid_department_id", "departmentId must be a UUID.", 400);
        if (!hasDepartmentRole(app, departmentId, "editor"))
            return errorResponse("department_forbidden", "Editor access to this department is required.", 403);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(name)) {
            return errorResponse("invalid_folder_name", "name must contain 1 to 160 characters and cannot contain path separators.", 400);
        }
        const parentFolderId =
            body.parentFolderId === undefined || body.parentFolderId === null || body.parentFolderId === "" ? null : body.parentFolderId;
        if (parentFolderId !== null && (typeof parentFolderId !== "string" || !UUID_PATTERN.test(parentFolderId))) {
            return errorResponse("invalid_parent_folder_id", "parentFolderId must be a UUID or null.", 400);
        }
        if (parentFolderId && !(await canSeeFolder(app, departmentId, parentFolderId)))
            return errorResponse("parent_folder_not_found", "Parent folder was not found.", 404);
        const folder = await new PostgresFolderRepository().create({
            tenantId: app.tenantId,
            applicationId: app.applicationId,
            departmentId,
            parentFolderId,
            name,
        });
        if (!folder) return errorResponse("parent_folder_not_found", "Parent folder was not found.", 404);
        return Response.json({ data: folder }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        const dbError = error as { code?: string; message?: string };
        if (dbError.code === "23505")
            return errorResponse("folder_name_conflict", "A folder with this name already exists at this level.", 409);
        console.error("Could not create folder", { code: dbError.code, message: dbError.message ?? "Unknown error" });
        return errorResponse("service_unavailable", "Could not create folder.", 503);
    }
}
