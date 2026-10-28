import { getDatabasePool } from "@/infrastructure/database/pool";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { departmentIdsForRole, hasDepartmentRole } from "@/application/auth/department-authorization";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ fileId: string }> }): Promise<Response> {
  try {
    const app = await authenticateApplicationKey(request);
    if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
    if (!app.scopes.includes("files:write")) return errorResponse("forbidden", "The API key does not have files:write scope.", 403);
    const { fileId } = await params;
    if (!UUID_PATTERN.test(fileId)) return errorResponse("invalid_file_id", "fileId must be a UUID.", 400);
    let body: unknown;
    try { body = await request.json(); } catch { return errorResponse("invalid_json", "Request body must be valid JSON.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
    const input = body as { ownerSubject?: unknown; displayName?: unknown; departmentId?: unknown; tags?: unknown; folderId?: unknown };
    const ownerSubject = typeof input.ownerSubject === "string" ? input.ownerSubject.trim() : "";
    if (!ownerSubject || ownerSubject.length > 255) return errorResponse("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
    const displayName = input.displayName === undefined ? null : typeof input.displayName === "string" ? input.displayName.trim() : "";
    const departmentId = input.departmentId === undefined ? null : input.departmentId === null || input.departmentId === "" ? null : typeof input.departmentId === "string" ? input.departmentId : "";
    const folderId = input.folderId === undefined ? null : input.folderId;
    const tags = input.tags === undefined ? null : input.tags;
    if (displayName !== null && (!displayName || displayName.length > 255)) return errorResponse("invalid_display_name", "displayName must contain 1 to 255 characters.", 400);
    if (departmentId !== null && (typeof departmentId !== "string" || !UUID_PATTERN.test(departmentId))) return errorResponse("invalid_department_id", "departmentId must be a UUID or null.", 400);
    if (input.departmentId !== undefined && departmentId === null) return errorResponse("invalid_department_id", "departmentId cannot be null.", 400);
    if (typeof departmentId === "string" && !hasDepartmentRole(app, departmentId, "editor")) return errorResponse("department_forbidden", "Editor access to the target department is required.", 403);
    if (folderId !== null && (typeof folderId !== "string" || !UUID_PATTERN.test(folderId))) return errorResponse("invalid_folder_id", "folderId must be a UUID or null.", 400);
    if (tags !== null && (!Array.isArray(tags) || tags.length > 50 || !tags.every((tag) => typeof tag === "string" && tag.trim().length > 0 && tag.length <= 64))) return errorResponse("invalid_tags", "tags must be an array of up to 50 non-empty strings (64 characters max each) or null.", 400);

    const result = await getDatabasePool().query(
      `update filesvc.files f
       set display_name = coalesce($5, f.display_name),
           department_id = case when $10::boolean then $11::uuid else f.department_id end,
           department = case when $10::boolean then (select d.name from filesvc.departments d where d.id = $11::uuid) else f.department end,
           tags = coalesce($6::text[], f.tags),
           folder_id = case when $7::boolean then $8::uuid when $10::boolean then null else f.folder_id end,
           updated_at = now()
       where f.id = $1 and f.tenant_id = $2 and f.application_id = $3 and f.owner_subject = $4
         and f.department_id = any($9::uuid[]) and f.status = 'available'
         and ($10::boolean = false or exists (
           select 1 from filesvc.departments d where d.id = $11::uuid and d.tenant_id = $2 and d.application_id = $3 and d.status = 'active'
         ))
         and ($7::boolean = false or $8::uuid is null or exists (
           select 1 from filesvc.folders d where d.id = $8 and d.tenant_id = $2 and d.application_id = $3
             and d.department_id = case when $10::boolean then $11::uuid else f.department_id end
         ))
       returning f.id, f.display_name, f.department_id as "departmentId", f.department, f.tags, f.folder_id as "folderId", f.updated_at as "updatedAt"`,
      [fileId, app.tenantId, app.applicationId, ownerSubject, displayName, tags, input.folderId !== undefined, folderId, departmentIdsForRole(app, "editor"), input.departmentId !== undefined, departmentId],
    );
    if (!result.rows[0]) return errorResponse("file_or_folder_not_found", "File or target folder was not found.", 404);
    return Response.json({ data: result.rows[0] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not update file metadata", { message: error instanceof Error ? error.message : "Unknown error" });
    return errorResponse("service_unavailable", "Could not update file metadata.", 503);
  }
}
