import { auditRoute } from "@/infrastructure/audit/audit-route";
import { recordAudit } from "@/infrastructure/audit/record-audit";
import { randomBytes } from "node:crypto";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { getDatabasePool } from "@/infrastructure/database/pool";

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function handleGET(request: Request): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!app.scopes.includes("files:read") && !app.scopes.includes("keys:manage"))
            return errorResponse("forbidden", "The API key does not have files:read or keys:manage scope.", 403);
        return Response.json({ data: { items: app.departments } }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.error("Could not list departments", { message: error instanceof Error ? error.message : "Unknown error" });
        return errorResponse("service_unavailable", "Could not list departments.", 503);
    }
}

async function handlePOST(request: Request): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!app.scopes.includes("departments:manage"))
            return errorResponse("forbidden", "Application administrator access is required.", 403);
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
        }
        const name =
            body && typeof body === "object" && !Array.isArray(body) && "name" in body && typeof body.name === "string"
                ? body.name.trim()
                : "";
        if (!name || name.length > 160) return errorResponse("invalid_department_name", "name must contain 1 to 160 characters.", 400);
        const code = `dept-${randomBytes(6).toString("hex")}`;
        const client = await getDatabasePool().connect();
        try {
            await client.query("begin");
            const result = await client.query(
                `insert into filesvc.departments (tenant_id, application_id, code, name)
       values ($1, $2, $3, $4)
       returning id, code, name, status, created_at as "createdAt"`,
                [app.tenantId, app.applicationId, code, name],
            );
            await recordAudit(
                app,
                {
                    action: "department.create",
                    outcome: "success",
                    resourceType: "department",
                    resourceId: result.rows[0].id,
                    details: { name },
                },
                client,
            );
            await client.query("commit");
            return Response.json({ data: result.rows[0] }, { status: 201, headers: { "Cache-Control": "no-store" } });
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        const dbError = error as { code?: string; message?: string };
        if (dbError.code === "23505") return errorResponse("department_name_conflict", "A department with this name already exists.", 409);
        console.error("Could not create department", { code: dbError.code, message: dbError.message ?? "Unknown error" });
        return errorResponse("service_unavailable", "Could not create department.", 503);
    }
}

export const GET = auditRoute("department.list", "department", handleGET, { recordSuccess: false, signedUrl: false });
export const POST = auditRoute("department.create", "department", handlePOST, { recordSuccess: false, signedUrl: false });
