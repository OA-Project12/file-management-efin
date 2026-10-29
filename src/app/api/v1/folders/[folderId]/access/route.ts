import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { getDatabasePool } from "@/infrastructure/database/pool";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
type Context = { params: Promise<{ folderId: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return fail("unauthorized", "A valid user session is required.", 401);
        if (!app.userId || !app.isTenantAdmin) return fail("forbidden", "Tenant Admin access is required.", 403);
        const { folderId } = await params;
        if (!UUID.test(folderId)) return fail("invalid_folder_id", "folderId must be a UUID.", 400);
        const result = await getDatabasePool().query<{
            id: string;
            department_id: string;
            visibility: string;
            user_ids: string[];
        }>(
            `select f.id, f.department_id, f.visibility,
              coalesce(array_agg(a.user_id order by a.user_id) filter (where a.user_id is not null), '{}'::uuid[]) as user_ids
       from filesvc.folders f
       left join filesvc.folder_user_access a on a.tenant_id = f.tenant_id and a.application_id = f.application_id and a.folder_id = f.id
       where f.id = $1 and f.tenant_id = $2 and f.application_id = $3
       group by f.id`,
            [folderId, app.tenantId, app.applicationId],
        );
        const row = result.rows[0];
        if (!row) return fail("folder_not_found", "Folder was not found.", 404);
        return Response.json(
            { data: { folderId: row.id, departmentId: row.department_id, visibility: row.visibility, userIds: row.user_ids } },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("Could not read folder access", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not read folder access.", 503);
    }
}

export async function PATCH(request: Request, { params }: Context): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return fail("unauthorized", "A valid user session is required.", 401);
        if (!app.userId || !app.isTenantAdmin) return fail("forbidden", "Tenant Admin access is required.", 403);
        const { folderId } = await params;
        if (!UUID.test(folderId)) return fail("invalid_folder_id", "folderId must be a UUID.", 400);
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return fail("invalid_json", "Request body must be valid JSON.", 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_json", "Request body must be an object.", 400);
        const input = body as { visibility?: unknown; userIds?: unknown };
        if (input.visibility !== "department" && input.visibility !== "restricted")
            return fail("invalid_visibility", "visibility must be department or restricted.", 400);
        if (
            !Array.isArray(input.userIds) ||
            input.userIds.length > 100 ||
            input.userIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
            new Set(input.userIds).size !== input.userIds.length
        ) {
            return fail("invalid_users", "userIds must be a unique list of at most 100 user IDs.", 400);
        }
        const userIds = input.userIds as string[];
        const client = await getDatabasePool().connect();
        try {
            await client.query("begin");
            const folder = await client.query<{ department_id: string; parent_folder_id: string | null }>(
                `select department_id, parent_folder_id from filesvc.folders where id = $1 and tenant_id = $2 and application_id = $3 for update`,
                [folderId, app.tenantId, app.applicationId],
            );
            const row = folder.rows[0];
            if (!row) {
                await client.query("rollback");
                return fail("folder_not_found", "Folder was not found.", 404);
            }
            if (userIds.length) {
                const eligible = await client.query<{ user_id: string }>(
                    `select tu.user_id from filesvc.tenant_users tu
           join filesvc.user_department_roles ur on ur.tenant_id = tu.tenant_id and ur.user_id = tu.user_id
           where tu.tenant_id = $1 and tu.status = 'active' and ur.application_id = $2
             and ur.department_id = $3 and tu.user_id = any($4::uuid[])
             and filesvc.folder_visible($1::uuid, $2::uuid, $3::uuid, $5::uuid, tu.user_id)`,
                    [app.tenantId, app.applicationId, row.department_id, userIds, row.parent_folder_id],
                );
                if (eligible.rowCount !== userIds.length) {
                    await client.query("rollback");
                    return fail("invalid_users", "Each user needs department access and access to every restricted ancestor.", 400);
                }
            }
            await client.query(
                `update filesvc.folders set visibility = $4, updated_at = now() where id = $1 and tenant_id = $2 and application_id = $3`,
                [folderId, app.tenantId, app.applicationId, input.visibility],
            );
            await client.query(`delete from filesvc.folder_user_access where tenant_id = $1 and application_id = $2 and folder_id = $3`, [
                app.tenantId,
                app.applicationId,
                folderId,
            ]);
            if (input.visibility === "restricted" && userIds.length)
                await client.query(
                    `insert into filesvc.folder_user_access (tenant_id, application_id, department_id, folder_id, user_id)
         select $1, $2, $3, $4, unnest($5::uuid[])`,
                    [app.tenantId, app.applicationId, row.department_id, folderId, userIds],
                );
            await client.query("commit");
            return Response.json(
                { data: { folderId, visibility: input.visibility, userIds: input.visibility === "restricted" ? userIds : [] } },
                { headers: { "Cache-Control": "no-store" } },
            );
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error("Could not update folder access", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not update folder access.", 503);
    }
}
