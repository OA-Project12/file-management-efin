import { createClient } from "@supabase/supabase-js";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { getDatabasePool } from "@/infrastructure/database/pool";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
type Grant = { departmentId: string; role: "admin" | "editor" | "viewer" };

export async function POST(request: Request): Promise<Response> {
    try {
        const admin = await authenticateApplicationKey(request);
        if (!admin) return fail("unauthorized", "A valid user session is required.", 401);
        if (!admin.userId || !admin.isTenantAdmin) return fail("forbidden", "Tenant Admin access is required.", 403);
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return fail("invalid_json", "Request body must be valid JSON.", 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_json", "Request body must be an object.", 400);
        const input = body as { email?: unknown; departmentGrants?: unknown };
        const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
        if (email.length > 320 || !EMAIL.test(email)) return fail("invalid_email", "A valid email is required.", 400);
        if (!Array.isArray(input.departmentGrants) || input.departmentGrants.length < 1 || input.departmentGrants.length > 100) {
            return fail("invalid_grants", "departmentGrants must contain 1 to 100 entries.", 400);
        }
        const grants = input.departmentGrants as Grant[];
        if (
            grants.some((grant) => !grant || !UUID.test(grant.departmentId) || !["admin", "editor", "viewer"].includes(grant.role)) ||
            new Set(grants.map((grant) => grant.departmentId)).size !== grants.length
        ) {
            return fail("invalid_grants", "Department grants are invalid or duplicated.", 400);
        }
        const allowed = new Set(admin.departments.map((department) => department.id));
        if (grants.some((grant) => !allowed.has(grant.departmentId)))
            return fail("department_forbidden", "A department is outside this application.", 403);
        const url = process.env.SUPABASE_URL;
        const secret = process.env.SUPABASE_SECRET_KEY;
        if (!url || !secret) throw new Error("Supabase Auth is not configured.");
        const auth = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
        const { data, error } = await auth.auth.admin.inviteUserByEmail(email, {
            redirectTo: process.env.AUTH_INVITE_REDIRECT_URL || undefined,
        });
        if (error || !data.user) return fail("invite_failed", error?.message ?? "Could not invite user.", 409);

        const pool = getDatabasePool();
        const client = await pool.connect();
        try {
            await client.query("begin");
            await client.query(`insert into filesvc.tenant_users (tenant_id, user_id, invited_by) values ($1, $2, $3)`, [
                admin.tenantId,
                data.user.id,
                admin.userId,
            ]);
            for (const grant of grants) {
                await client.query(
                    `insert into filesvc.user_department_roles (tenant_id, application_id, department_id, user_id, role)
           values ($1, $2, $3, $4, $5)`,
                    [admin.tenantId, admin.applicationId, grant.departmentId, data.user.id, grant.role],
                );
            }
            await client.query("commit");
        } catch (dbError) {
            await client.query("rollback").catch(() => undefined);
            console.error("Invited Auth user has no tenant membership", { userId: data.user.id });
            throw dbError;
        } finally {
            client.release();
        }
        return Response.json(
            { data: { userId: data.user.id, email, departmentGrants: grants } },
            { status: 201, headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("Could not invite user", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not invite user.", 503);
    }
}
