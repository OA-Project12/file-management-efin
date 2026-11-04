import { logger } from "../src/infrastructure/security/logger.mjs";
import { createRequire } from "node:module";
import process from "node:process";
import { purgeFileObjects, finishFilePurge } from "./file-purge.mjs";
import { createClient } from "@supabase/supabase-js";
import { runObjectCleanup } from "./object-cleanup.mjs";
import { removeStoredObjectIfPresent } from "./worker-storage.mjs";
import { enterStorageMutation } from "../src/infrastructure/storage/storage-maintenance.mjs";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

const EVENT_TYPE = "file.object_delete_requested";
const BATCH_SIZE = 10;
const LEASE_SECONDS = 600;
const IDLE_DELAY_MS = 2_000;

const workerDatabaseUrl = process.env.WORKER_DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!workerDatabaseUrl || !supabaseUrl || !supabaseSecretKey) {
    logger.error("WORKER_DATABASE_URL, SUPABASE_URL, and SUPABASE_SECRET_KEY must be configured.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: workerDatabaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
});

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
        fetch: (input, init) =>
            fetch(input, {
                ...init,
                signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(init?.signal ? [init.signal] : [])]),
            }),
    },
});

let stopping = false;
process.on("SIGINT", () => {
    stopping = true;
});
process.on("SIGTERM", () => {
    stopping = true;
});

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function claimEvent() {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const selected = await client.query(
            `
        select id, aggregate_id, payload, attempts
        from filesvc.outbox
        where event_type = $1
          and processed_at is null
          and available_at <= now()
        order by available_at, id
        for update skip locked
        limit 1
      `,
            [EVENT_TYPE],
        );

        const event = selected.rows[0];
        if (!event) {
            await client.query("commit");
            return null;
        }

        await client.query(
            `
        update filesvc.outbox
        set attempts = attempts + 1,
            available_at = now() + ($2::int * interval '1 second')
        where id = $1
      `,
            [event.id, LEASE_SECONDS],
        );
        await client.query("commit");
        return { ...event, attempts: event.attempts + 1 };
    } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

function validatePayload(event) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") throw new Error("Invalid outbox payload.");

    const { fileId, tenantId, applicationId, bucketId, objectKey } = payload;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (![fileId, tenantId, applicationId].every((value) => typeof value === "string" && uuidPattern.test(value))) {
        throw new Error("Outbox payload has invalid identifiers.");
    }
    if (fileId !== event.aggregate_id) throw new Error("Outbox aggregate does not match the payload.");
    if (typeof bucketId !== "string" || !/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(bucketId)) {
        throw new Error("Outbox payload has an invalid bucket ID.");
    }
    const prefix = `${tenantId}/${applicationId}/${fileId}`;
    const suffix =
        typeof objectKey === "string" && objectKey.startsWith(`${prefix}/versions/`) ? objectKey.slice(`${prefix}/versions/`.length) : "";
    if (objectKey !== prefix && !uuidPattern.test(suffix)) {
        throw new Error("Outbox payload has an unexpected object key.");
    }

    return { fileId, tenantId, applicationId, bucketId, objectKey };
}

async function removeObjectIfPresent(bucketId, objectKey) {
    await removeStoredObjectIfPresent(supabase, bucketId, objectKey);
}

async function scheduleRetry(event, error) {
    const retrySeconds = Math.min(30 * 2 ** Math.min(event.attempts, 7), 3_600);
    await pool.query(
        `
      update filesvc.outbox
      set available_at = now() + ($2::int * interval '1 second')
      where id = $1 and processed_at is null
    `,
        [event.id, retrySeconds],
    );
    logger.error("Outbox event failed; retry scheduled", {
        outboxId: event.id,
        attempts: event.attempts,
        retrySeconds,
        message: error instanceof Error ? error.message : "Unknown worker error",
    });
}

async function processEvent(event) {
    try {
        const file = validatePayload(event);
        const verified = await purgeFileObjects(pool, file, removeObjectIfPresent);
        await finishFilePurge(pool, event, file, verified);
        logger.info("File deletion completed", { outboxId: event.id, fileId: file.fileId });
    } catch (error) {
        await scheduleRetry(event, error);
    }
}

async function main() {
    logger.info("Outbox worker started.");
    let nextAuditMaintenance = 0;
    let nextObjectCleanup = 0;
    try {
        while (!stopping) {
            if (Date.now() >= nextObjectCleanup) {
                const release = enterStorageMutation();
                if (release) {
                    try {
                        const result = await runObjectCleanup(pool, removeObjectIfPresent, { limit: BATCH_SIZE, stopping: () => stopping });
                        if (result.scheduled || result.processed) logger.info("Object cleanup cycle completed", result);
                    } catch (error) {
                        logger.error("Object cleanup cycle failed; retrying in one minute", {
                            code: typeof error?.code === "string" ? error.code : "cleanup_cycle_failed",
                        });
                    } finally {
                        release();
                    }
                    nextObjectCleanup = Date.now() + 60_000;
                }
            }
            if (Date.now() >= nextAuditMaintenance) {
                try {
                    const result = await pool.query("select filesvc.maintain_audit_retention() as result");
                    logger.info("Audit retention completed", result.rows[0]?.result);
                    nextAuditMaintenance = Date.now() + 24 * 60 * 60 * 1000;
                } catch (error) {
                    const message = error instanceof Error ? error.message : "Unknown error";
                    logger.error("Audit retention failed; operator attention required", { message });
                    if (process.env.AUDIT_ALERT_WEBHOOK_URL) {
                        try {
                            const alert = await fetch(process.env.AUDIT_ALERT_WEBHOOK_URL, {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    event: "audit_retention_failed",
                                    service: "file-management-efin",
                                    occurredAt: new Date().toISOString(),
                                }),
                                signal: AbortSignal.timeout(5000),
                            });
                            if (!alert.ok) logger.error("Audit alert delivery failed", { status: alert.status });
                        } catch (alertError) {
                            logger.error("Audit alert delivery failed", {
                                message: alertError instanceof Error ? alertError.message : "Unknown error",
                            });
                        }
                    }
                    nextAuditMaintenance = Date.now() + 60 * 60 * 1000;
                }
            }
            let processed = 0;
            for (let index = 0; index < BATCH_SIZE && !stopping; index += 1) {
                const release = enterStorageMutation();
                if (!release) break;
                try {
                    const event = await claimEvent();
                    if (!event) break;
                    processed += 1;
                    await processEvent(event);
                } finally {
                    release();
                }
            }
            if (processed === 0 && !stopping) await sleep(IDLE_DELAY_MS);
        }
    } finally {
        await pool.end();
        logger.info("Outbox worker stopped.");
    }
}

main().catch((error) => {
    logger.error("Outbox worker stopped after an unexpected error", {
        code: typeof error?.code === "string" ? error.code : undefined,
        message: error instanceof Error ? error.message : "Unknown worker error",
    });
    process.exitCode = 1;
});
