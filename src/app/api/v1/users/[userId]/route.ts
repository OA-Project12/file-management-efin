import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { getDatabasePool } from "@/infrastructure/database/pool";
import { recordAudit } from "@/infrastructure/audit/record-audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
type Grant = { departmentId: string; role: "admin" | "editor" | "viewer" };

async function handlePATCH(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
    try {
        const admin = await authenticateApplicationKey(request);
        if (!admin) return fail("unauthorized", "A valid user session is required.", 401);
        if (!admin.userId || !admin.isTenantAdmin) return fail("forbidden", "Tenant Admin access is required.", 403);
        const { userId } = await params;
        if (!UUID.test(userId)) return fail("invalid_user_id", "userId must be a UUID.", 400);
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return fail("invalid_json", "Request body must be valid JSON.", 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_json", "Request body must be an object.", 400);
        const input = body as { status?: unknown; departmentGrants?: unknown };
        const status = input.status;
        if (status !== undefined && status !== "active" && status !== "suspended")
            return fail("invalid_status", "status must be active or suspended.", 400);
        let grants: Grant[] | undefined;
        if (input.departmentGrants !== undefined) {
            if (!Array.isArray(input.departmentGrants) || input.departmentGrants.length > 100)
                return fail("invalid_grants", "departmentGrants must contain at most 100 entries.", 400);
            grants = input.departmentGrants as Grant[];
            if (
                grants.some((grant) => !grant || !UUID.test(grant.departmentId) || !["admin", "editor", "viewer"].includes(grant.role)) ||
                new Set(grants.map((grant) => grant.departmentId)).size !== grants.length
            )
                return fail("invalid_grants", "Department grants are invalid or duplicated.", 400);
            const allowed = new Set(admin.departments.map((department) => department.id));
            if (grants.some((grant) => !allowed.has(grant.departmentId)))
                return fail("department_forbidden", "A department is outside this application.", 403);
        }
        if (status === undefined && grants === undefined) return fail("invalid_body", "Set status or departmentGrants.", 400);
        const client = await getDatabasePool().connect();
        try {
            await client.query("begin");
            const member = await client.query<{ is_admin: boolean; status: string }>(
                `select is_admin, status from filesvc.tenant_users where tenant_id = $1 and user_id = $2 for update`,
                [admin.tenantId, userId],
            );
            if (!member.rows[0]) {
                await client.query("rollback");
                return fail("user_not_found", "User is not a tenant member.", 404);
            }
            if (member.rows[0].is_admin) {
                await client.query("rollback");
                return fail("admin_protected", "Tenant Admin must be managed separately.", 409);
            }
            const previousGrants = await client.query<{ department_id: string; role: string }>(
                `select department_id, role from filesvc.user_department_roles
                 where tenant_id = $1 and application_id = $2 and user_id = $3`,
                [admin.tenantId, admin.applicationId, userId],
            );
            const beforeGrantCount = previousGrants.rowCount ?? 0;
            const beforeGrants = previousGrants.rows.map((grant) => `${grant.department_id}:${grant.role}`).sort().join(",");
            const afterGrants = grants === undefined ? beforeGrants : grants.map((grant) => `${grant.departmentId}:${grant.role}`).sort().join(",");
            if (status !== undefined)
                await client.query(`update filesvc.tenant_users set status = $3 where tenant_id = $1 and user_id = $2`, [
                    admin.tenantId,
                    userId,
                    status,
                ]);
            if (grants !== undefined) {
                await client.query(
                    `delete from filesvc.user_department_roles where tenant_id = $1 and application_id = $2 and user_id = $3`,
                    [admin.tenantId, admin.applicationId, userId],
                );
                for (const grant of grants)
                    await client.query(
                        `insert into filesvc.user_department_roles (tenant_id, application_id, department_id, user_id, role)
           values ($1, $2, $3, $4, $5)`,
                        [admin.tenantId, admin.applicationId, grant.departmentId, userId, grant.role],
                    );
            }
            await recordAudit(admin, { action: "user.access_update", outcome: "success", resourceType: "user", resourceId: userId,
                details: { beforeStatus: member.rows[0].status, afterStatus: typeof status === "string" ? status : member.rows[0].status,
                    beforeGrantCount, afterGrantCount: grants?.length ?? beforeGrantCount, beforeGrants, afterGrants } }, client);
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
        return Response.json(
            { data: { userId, status: status ?? null, departmentGrants: grants ?? null } },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("Could not update user access", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not update user access.", 503);
    }
}

export const PATCH = auditRoute("user.access_update", "user", handlePATCH, { recordSuccess: false, signedUrl: false });
