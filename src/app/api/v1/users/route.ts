import { createClient } from "@supabase/supabase-js";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { getDatabasePool } from "@/infrastructure/database/pool";

const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request): Promise<Response> {
    try {
        const admin = await authenticateApplicationKey(request);
        if (!admin) return fail("unauthorized", "A valid user session is required.", 401);
        if (!admin.userId || !admin.isTenantAdmin) return fail("forbidden", "Tenant Admin access is required.", 403);
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "1");
        if (!Number.isInteger(page) || page < 1 || page > 100000) return fail("invalid_page", "page must be a positive integer.", 400);
        const members = await getDatabasePool().query<{
            user_id: string;
            status: "active" | "suspended";
            is_admin: boolean;
            created_at: string;
            department_id: string | null;
            role: "admin" | "editor" | "viewer" | null;
        }>(
            `with members as (
         select user_id, status, is_admin, created_at
         from filesvc.tenant_users
         where tenant_id = $1
         order by created_at desc, user_id desc
         limit 26 offset $3
       )
       select m.*, r.department_id, r.role
       from members m
       left join filesvc.user_department_roles r
         on r.tenant_id = $1 and r.application_id = $2 and r.user_id = m.user_id
       order by m.created_at desc, m.user_id desc, r.department_id`,
            [admin.tenantId, admin.applicationId, (page - 1) * 25],
        );
        const unique = new Map<
            string,
            {
                userId: string;
                status: string;
                isTenantAdmin: boolean;
                createdAt: string;
                departmentGrants: { departmentId: string; role: string }[];
            }
        >();
        for (const row of members.rows) {
            if (!unique.has(row.user_id))
                unique.set(row.user_id, {
                    userId: row.user_id,
                    status: row.status,
                    isTenantAdmin: row.is_admin,
                    createdAt: row.created_at,
                    departmentGrants: [],
                });
            if (row.department_id && row.role)
                unique.get(row.user_id)!.departmentGrants.push({ departmentId: row.department_id, role: row.role });
        }
        const hasMore = unique.size > 25;
        const items = [...unique.values()].slice(0, 25);
        const projectUrl = process.env.SUPABASE_URL;
        const secret = process.env.SUPABASE_SECRET_KEY;
        if (!projectUrl || !secret) throw new Error("Supabase Auth is not configured.");
        const auth = createClient(projectUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });
        const resolved = await Promise.all(
            items.map(async (item) => {
                const { data, error } = await auth.auth.admin.getUserById(item.userId);
                if (error) throw error;
                return { ...item, email: data.user?.email ?? null };
            }),
        );
        return Response.json(
            { data: { items: resolved, nextPage: hasMore ? page + 1 : null } },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("Could not list tenant users", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not list users.", 503);
    }
}
