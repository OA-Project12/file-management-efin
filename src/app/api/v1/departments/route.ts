import { randomBytes } from "node:crypto";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { getDatabasePool } from "@/infrastructure/database/pool";

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const app = await authenticateApplicationKey(request);
    if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
    if (!app.scopes.includes("files:read") && !app.scopes.includes("keys:manage")) return errorResponse("forbidden", "The API key does not have files:read or keys:manage scope.", 403);
    return Response.json({ data: { items: app.departments } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not list departments", { message: error instanceof Error ? error.message : "Unknown error" });
    return errorResponse("service_unavailable", "Could not list departments.", 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const app = await authenticateApplicationKey(request);
    if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
    if (!app.scopes.includes("departments:manage")) return errorResponse("forbidden", "Application administrator access is required.", 403);
    let body: unknown;
    try { body = await request.json(); } catch { return errorResponse("invalid_json", "Request body must be valid JSON.", 400); }
    const name = body && typeof body === "object" && !Array.isArray(body) && "name" in body && typeof body.name === "string"
      ? body.name.trim() : "";
    if (!name || name.length > 160) return errorResponse("invalid_department_name", "name must contain 1 to 160 characters.", 400);
    const code = `dept-${randomBytes(6).toString("hex")}`;
    const result = await getDatabasePool().query(
      `insert into filesvc.departments (tenant_id, application_id, code, name)
       values ($1, $2, $3, $4)
       returning id, code, name, status, created_at as "createdAt"`,
      [app.tenantId, app.applicationId, code, name],
    );
    return Response.json({ data: result.rows[0] }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const dbError = error as { code?: string; message?: string };
    if (dbError.code === "23505") return errorResponse("department_name_conflict", "A department with this name already exists.", 409);
    console.error("Could not create department", { code: dbError.code, message: dbError.message ?? "Unknown error" });
    return errorResponse("service_unavailable", "Could not create department.", 503);
  }
}
