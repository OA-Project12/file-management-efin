import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { accessibleDepartmentIds, hasDepartmentRole } from "@/application/auth/department-authorization";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
  try {
    const app = await authenticateApplicationKey(request);
    if (!app) return fail("unauthorized", "A valid API key is required.", 401);
    if (!app.scopes.includes("files:read")) return fail("forbidden", "files:read scope is required.", 403);
    const query = new URL(request.url).searchParams;
    const ownerSubject = query.get("ownerSubject")?.trim() ?? "";
    const departmentId = query.get("departmentId") || undefined;
    if (!ownerSubject || ownerSubject.length > 255) return fail("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
    if (departmentId && !UUID_PATTERN.test(departmentId)) return fail("invalid_department_id", "departmentId must be a UUID.", 400);
    if (departmentId && !hasDepartmentRole(app, departmentId, "viewer")) return fail("department_forbidden", "The API key has no access to this department.", 403);
    const items = await new PostgresFileRepository().listTrash({
      tenantId: app.tenantId, applicationId: app.applicationId,
      ownerSubject, departmentIds: accessibleDepartmentIds(app),
    }, departmentId);
    return Response.json({ data: { items } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not list trash", { message: error instanceof Error ? error.message : "Unknown error" });
    return fail("service_unavailable", "Could not list trash.", 503);
  }
}
