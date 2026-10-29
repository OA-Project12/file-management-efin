import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const args = Object.fromEntries(
    process.argv.slice(2).map((part) => {
        const separator = part.indexOf("=");
        return separator > 2 && part.startsWith("--") ? [part.slice(2, separator), part.slice(separator + 1)] : [part, ""];
    }),
);
const email = args.email?.trim().toLowerCase();
const tenantId = args["tenant-id"];
const applicationId = process.env.AUTH_APPLICATION_ID;
const url = process.env.SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const databaseUrl = process.env.DATABASE_URL;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if (
    !email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !uuid.test(tenantId ?? "") ||
    !uuid.test(applicationId ?? "") ||
    !url ||
    !secret ||
    !databaseUrl
) {
    console.error("Usage: npm.cmd run admin:bootstrap -- --email=admin@example.com --tenant-id=<UUID>");
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const auth = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
try {
    const check = await pool.query(
        `select exists(select 1 from filesvc.applications where id = $1 and tenant_id = $2 and status = 'active') as valid_app,
            exists(select 1 from filesvc.tenant_users where tenant_id = $2 and is_admin and status = 'active') as has_admin`,
        [applicationId, tenantId],
    );
    if (!check.rows[0]?.valid_app) throw new Error("Application does not belong to the active tenant.");
    if (check.rows[0].has_admin) throw new Error("This tenant already has an active Admin.");
    const { data, error } = await auth.auth.admin.inviteUserByEmail(email, {
        redirectTo: process.env.AUTH_INVITE_REDIRECT_URL || undefined,
    });
    if (error || !data.user) throw error ?? new Error("Invite did not return a user.");
    try {
        await pool.query(`insert into filesvc.tenant_users (tenant_id, user_id, is_admin) values ($1, $2, true)`, [tenantId, data.user.id]);
    } catch (dbError) {
        console.error("Invited Auth user has no tenant membership", { userId: data.user.id });
        throw dbError;
    }
    console.log("Tenant Admin invited", { tenantId, userId: data.user.id, email });
} catch (error) {
    console.error("Tenant Admin bootstrap failed", { message: error instanceof Error ? error.message : "Unknown error" });
    process.exitCode = 1;
} finally {
    await pool.end();
}
