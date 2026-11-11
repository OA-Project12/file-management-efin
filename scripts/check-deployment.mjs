// Read-only preflight. Does not start the worker, process outbox or change data.
import { Pool } from "pg";
import { createClient } from "@supabase/supabase-js";
import { checkRedisReady, closeRedis, mode } from "../src/infrastructure/security/rate-limit.mjs";

const target = process.argv[2];
if (!["web", "worker"].includes(target)) {
    console.error("Usage: node scripts/check-deployment.mjs web|worker");
    process.exit(1);
}
const checks = {};
let pool;
try {
    const connectionString = process.env[target === "web" ? "DATABASE_URL" : "WORKER_DATABASE_URL"];
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode") !== "verify-full" || url.searchParams.has("uselibpqcompat")) {
        throw Object.assign(new Error(), { code: "VERIFY_FULL_REQUIRED" });
    }
    const role = target === "web" ? "filesvc_api" : "filesvc_worker";
    pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    const started = performance.now();
    const client = await pool.connect();
    try {
        const {
            rows: [identity],
        } = await client.query(
            `select current_user <> 'postgres' and current_user not like 'postgres.%' as dedicated,
        pg_has_role(current_user, $1, 'member') as authorized`,
            [role],
        );
        // Session Pooler terminates client TLS. pg_stat_ssl describes the pooler's
        // backend connection, not this client's verified TLS connection to it.
        const socket = client.connection.stream;
        const tls = socket.encrypted === true && socket.authorized === true;
        checks.database = {
            dedicatedLogin: identity.dedicated,
            expectedRole: identity.authorized,
            tls,
            roundTripMs: Math.round(performance.now() - started),
        };
        if (!identity.dedicated || !identity.authorized || !tls) throw Object.assign(new Error(), { code: "DATABASE_PREFLIGHT_FAILED" });
    } finally {
        client.release();
    }
    if (target === "web") {
        await checkRedisReady();
        checks.rateLimitMode = mode();
        const {
            rows: [application],
        } = await pool.query("select exists(select 1 from filesvc.applications where id=$1::uuid and status='active') as active", [
            process.env.AUTH_APPLICATION_ID,
        ]);
        checks.applicationActive = application.active;
        if (!application.active) throw Object.assign(new Error(), { code: "APPLICATION_NOT_ACTIVE" });
        const {
            rows: [session],
        } = await pool.query(`
      select case when to_regprocedure('filesvc.check_dms_session(uuid,uuid,uuid,timestamptz,boolean)') is not null then
        has_function_privilege(current_user, 'filesvc.check_dms_session(uuid,uuid,uuid,timestamptz,boolean)', 'EXECUTE')
        and has_column_privilege(current_user, 'filesvc.tenant_users', 'session_not_before', 'SELECT')
      else false end as ready
    `);
        checks.dmsSessionSchema = session.ready;
        if (!session.ready) throw Object.assign(new Error(), { code: "DMS_SESSION_SCHEMA_REQUIRED" });
        const { rows: [rotation] } = await pool.query(`
            select case when exists (
                select 1 from pg_attribute
                where attrelid = 'filesvc.application_keys'::regclass
                  and attname = 'rotated_from_key_id' and not attisdropped
            ) then
                has_column_privilege(current_user, 'filesvc.application_keys', 'rotated_from_key_id', 'SELECT')
                and has_column_privilege(current_user, 'filesvc.application_keys', 'rotated_from_key_id', 'INSERT')
                and has_column_privilege(current_user, 'filesvc.application_keys', 'expires_at', 'UPDATE')
                and exists (
                    select 1 from pg_index
                    where indrelid = 'filesvc.application_keys'::regclass
                      and indexrelid = to_regclass('filesvc.application_keys_rotated_from_uidx')
                      and indisunique and indisvalid
                )
            else false end as ready
        `);
        checks.keyRotationSchema = rotation.ready;
        if (!rotation.ready) throw Object.assign(new Error(), { code: "KEY_ROTATION_SCHEMA_REQUIRED" });
    } else {
        await pool.query("select id from filesvc.outbox limit 0");
        checks.outboxReadable = true;
        const {
            rows: [retention],
        } = await pool.query("select has_function_privilege(current_user, 'filesvc.maintain_audit_retention()', 'EXECUTE') as allowed");
        checks.retentionExecutable = retention.allowed;
        if (!retention.allowed) throw Object.assign(new Error(), { code: "RETENTION_PERMISSION_MISSING" });
    }
    const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) },
    });
    const { data: bucket, error } = await storage.storage.getBucket(process.env.STORAGE_BUCKET);
    if (error || !bucket) throw Object.assign(new Error(), { code: "BUCKET_LOOKUP_FAILED" });
    checks.bucket = {
        private: bucket.public === false,
        sizeLimitConfigured: bucket.file_size_limit !== null && bucket.file_size_limit !== undefined,
    };
    if (bucket.public) throw Object.assign(new Error(), { code: "PRIVATE_BUCKET_REQUIRED" });
    console.log(JSON.stringify({ target, status: "passed", checks }, null, 2));
} catch (error) {
    // Do not print URLs, driver messages or Supabase responses containing paths.
    console.error(
        JSON.stringify(
            { target, status: "failed", code: /^[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : "PREFLIGHT_FAILED", checks },
            null,
            2,
        ),
    );
    process.exitCode = 1;
} finally {
    await pool?.end();
    await closeRedis();
}
