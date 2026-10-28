import { createRequire } from "node:module";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

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
  console.error("WORKER_DATABASE_URL, SUPABASE_URL, and SUPABASE_SECRET_KEY must be configured.");
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
});

let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

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
  if (objectKey !== `${tenantId}/${applicationId}/${fileId}`) {
    throw new Error("Outbox payload has an unexpected object key.");
  }

  return { fileId, tenantId, applicationId, bucketId, objectKey };
}

async function removeObjectIfPresent(bucketId, objectKey) {
  const { data: info, error: infoError } = await supabase.storage.from(bucketId).info(objectKey);
  if (infoError) {
    if (infoError.status === 404) return;
    throw new Error(`Could not inspect Storage object: ${infoError.message}`);
  }
  if (!info) return;

  const { error } = await supabase.storage.from(bucketId).remove([objectKey]);
  if (error) throw new Error(`Could not remove Storage object: ${error.message}`);
}

async function finishEvent(event, file) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const fileUpdate = await client.query(
      `
        update filesvc.files
        set status = 'deleted', updated_at = now()
        where id = $1 and tenant_id = $2 and application_id = $3
          and status = 'deleting'
        returning id
      `,
      [file.fileId, file.tenantId, file.applicationId],
    );

    if (fileUpdate.rowCount !== 1) {
      const existing = await client.query(
        `select status from filesvc.files where id = $1 and tenant_id = $2 and application_id = $3`,
        [file.fileId, file.tenantId, file.applicationId],
      );
      const currentStatus = existing.rows[0]?.status;
      if (currentStatus !== "deleted") {
        console.error("Delete event completed but file status was not deleting", {
          outboxId: event.id,
          currentStatus: currentStatus ?? "missing",
        });
      }
    }

    await client.query(
      `update filesvc.outbox set processed_at = now() where id = $1 and processed_at is null`,
      [event.id],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function scheduleRetry(event, error) {
  const retrySeconds = Math.min(30 * (2 ** Math.min(event.attempts, 7)), 3_600);
  await pool.query(
    `
      update filesvc.outbox
      set available_at = now() + ($2::int * interval '1 second')
      where id = $1 and processed_at is null
    `,
    [event.id, retrySeconds],
  );
  console.error("Outbox event failed; retry scheduled", {
    outboxId: event.id,
    attempts: event.attempts,
    retrySeconds,
    message: error instanceof Error ? error.message : "Unknown worker error",
  });
}

async function processEvent(event) {
  try {
    const file = validatePayload(event);
    await removeObjectIfPresent(file.bucketId, file.objectKey);
    await finishEvent(event, file);
    console.log("File deletion completed", { outboxId: event.id, fileId: file.fileId });
  } catch (error) {
    await scheduleRetry(event, error);
  }
}

async function main() {
  console.log("Outbox worker started.");
  try {
    while (!stopping) {
      let processed = 0;
      for (let index = 0; index < BATCH_SIZE && !stopping; index += 1) {
        const event = await claimEvent();
        if (!event) break;
        processed += 1;
        await processEvent(event);
      }
      if (processed === 0 && !stopping) await sleep(IDLE_DELAY_MS);
    }
  } finally {
    await pool.end();
    console.log("Outbox worker stopped.");
  }
}

main().catch((error) => {
  console.error("Outbox worker stopped after an unexpected error", {
    code: typeof error?.code === "string" ? error.code : undefined,
    message: error instanceof Error ? error.message : "Unknown worker error",
  });
  process.exitCode = 1;
});
