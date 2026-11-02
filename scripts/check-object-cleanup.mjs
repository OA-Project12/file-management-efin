// Uses the real worker role and PostgreSQL engine with isolated TEMP tables.
// Production rows/Storage objects are never modified by the fixture tests.
// Run: node --env-file=.env.local scripts/check-object-cleanup.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { scheduleObjectCleanup, claimObjectCleanup, processObjectCleanup, runObjectCleanup } from "./object-cleanup.mjs";
import { removeStoredObjectIfPresent, isMissingStorageObject } from "./worker-storage.mjs";

const pool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
let seq = 0,
    failAudit = false;
const savepoints = [];
const wrapper = {
    async query(sql, values) {
        if (sql === "begin") {
            const name = `test_${++seq}`;
            savepoints.push(name);
            return client.query(`savepoint ${name}`);
        }
        if (sql === "commit") return client.query(`release savepoint ${savepoints.pop()}`);
        if (sql === "rollback") {
            const name = savepoints.pop();
            await client.query(`rollback to savepoint ${name}`);
            return client.query(`release savepoint ${name}`);
        }
        if (failAudit && sql.includes("insert into filesvc.audit_log")) throw new Error("Injected audit failure");
        return client.query(sql.replaceAll("filesvc.", "pg_temp."), values);
    },
    release() {},
};
const testPool = { connect: async () => wrapper, query: (...args) => wrapper.query(...args) };
const quiet = { log() {}, error() {} };
const removed = [];
const remove = async (bucket, key) => {
    removed.push(`${bucket}/${key}`);
};
const tenant = randomUUID(),
    app = randomUUID(),
    dept = randomUUID();
const expired = new Date(Date.now() - 7200_000),
    future = new Date(Date.now() + 7200_000);

async function initial(status = "pending_upload", expiry = expired, completed = false) {
    const id = randomUUID(),
        key = `${tenant}/${app}/${id}`;
    await wrapper.query(
        `insert into filesvc.files
      (id,tenant_id,application_id,department_id,owner_subject,bucket_id,object_key,original_name,display_name,content_type,size_bytes,status)
      values ($1,$2,$3,$4,'cleanup-fixture','private-files',$5,'fixture.txt','fixture.txt','text/plain',5,$6)`,
        [id, tenant, app, dept, key, status],
    );
    await wrapper.query(
        `insert into filesvc.upload_intents(file_id,token_fingerprint,expires_at,completed_at)
      values ($1,$2,$3,$4)`,
        [id, Buffer.alloc(32), expiry, completed ? new Date() : null],
    );
    return { id, key };
}
async function version(file, kind = "upload", status = "pending_upload", expiry = expired) {
    let base = (await wrapper.query(`select current_version_id from filesvc.files where id=$1`, [file.id])).rows[0].current_version_id;
    if (!base) {
        base = randomUUID();
        await wrapper.query(
            `insert into filesvc.file_versions
          (id,file_id,version_number,bucket_id,object_key,original_name,content_type,size_bytes,status,created_by_kind)
          values ($1,$2,1,'private-files',$3,'v1.txt','text/plain',5,'available','migration')`,
            [base, file.id, file.key],
        );
        await wrapper.query(`update filesvc.files set current_version_id=$2,status='available' where id=$1`, [file.id, base]);
    }
    const id = randomUUID(),
        key = `${file.key}/versions/${id}`;
    await wrapper.query(
        `insert into filesvc.file_versions
      (id,file_id,version_number,bucket_id,object_key,original_name,content_type,size_bytes,status,created_by_kind,restored_from_version_id)
      select $1,$2,coalesce(max(version_number),0)+1,'private-files',$3,'revision.txt','text/plain',5,$4,'migration',$5
      from filesvc.file_versions where file_id=$2`,
        [id, file.id, key, status, kind === "restore" ? base : null],
    );
    const table = kind === "restore" ? "version_restore_intents" : "version_upload_intents";
    await wrapper.query(`insert into filesvc.${table}(version_id,file_id,base_version_id,expires_at) values ($1,$2,$3,$4)`, [
        id,
        file.id,
        base,
        expiry,
    ]);
    return { id, key, base };
}
try {
    assert.equal(isMissingStorageObject({ status: 400, statusCode: "404" }), true);
    assert.equal(isMissingStorageObject({ status: 403, statusCode: "403", code: "AccessDenied" }), false);
    assert.equal(isMissingStorageObject({ status: 400, statusCode: "400", code: "InvalidRequest" }), false);
    await client.query("begin");
    for (const table of [
        "files",
        "file_versions",
        "upload_intents",
        "version_upload_intents",
        "version_restore_intents",
        "object_cleanup_jobs",
        "department_storage_quotas",
        "storage_allocations",
        "audit_log",
    ])
        await client.query(`create temp table ${table} (like filesvc.${table} including all) on commit drop`);
    const pending = await initial();
    assert.equal(await scheduleObjectCleanup(testPool), 1);
    assert.equal((await wrapper.query(`select status from filesvc.files where id=$1`, [pending.id])).rows[0].status, "failed");
    const first = await claimObjectCleanup(testPool);
    assert.ok(first);
    assert.equal(await claimObjectCleanup(testPool), null, "Lease prevents another immediate claim");
    assert.equal(await processObjectCleanup(testPool, first, remove, quiet), "completed");
    assert.equal(removed.length, 1);
    assert.equal(await scheduleObjectCleanup(testPool), 0, "Completed cleanup must not be queued again");

    await initial("pending_upload", future);
    await initial("failed", future);
    await initial("available", expired, true);
    const parent = await initial("available", expired, true);
    const live = await version(parent, "upload", "available");
    const fresh = await version(parent, "upload", "pending_upload", future);
    const restore = await version(parent, "restore");
    const quarantined = await version(parent, "upload", "quarantined");
    assert.equal(await scheduleObjectCleanup(testPool), 2);
    await runObjectCleanup(testPool, remove, { logger: quiet });
    assert.ok(removed.includes(`private-files/${restore.key}`));
    assert.ok(removed.includes(`private-files/${quarantined.key}`));
    assert.ok(!removed.includes(`private-files/${live.key}`));
    assert.ok(!removed.includes(`private-files/${fresh.key}`));
    assert.ok(!removed.includes(`private-files/${parent.key}`));

    const auditFixture = await version(parent);
    failAudit = true;
    await assert.rejects(scheduleObjectCleanup(testPool), /Injected audit failure/);
    failAudit = false;
    assert.equal(
        (await wrapper.query(`select status from filesvc.file_versions where id=$1`, [auditFixture.id])).rows[0].status,
        "pending_upload",
    );
    await scheduleObjectCleanup(testPool);
    let job = await claimObjectCleanup(testPool);
    failAudit = true;
    await assert.rejects(processObjectCleanup(testPool, job, remove, quiet), /Injected audit failure/);
    failAudit = false;
    assert.equal((await wrapper.query(`select status from filesvc.object_cleanup_jobs where id=$1`, [job.id])).rows[0].status, "pending");
    await wrapper.query(`update filesvc.object_cleanup_jobs set available_at=now() where id=$1`, [job.id]);
    job = await claimObjectCleanup(testPool);
    assert.equal(
        await processObjectCleanup(testPool, job, remove, quiet),
        "completed",
        "Missing object can be retried after audit rollback",
    );

    const network = await version(parent);
    await scheduleObjectCleanup(testPool);
    job = await claimObjectCleanup(testPool);
    assert.equal(
        await processObjectCleanup(
            testPool,
            job,
            async () => {
                throw Object.assign(new Error("Storage down"), { code: "storage_down" });
            },
            quiet,
        ),
        "retry",
    );
    assert.equal(await claimObjectCleanup(testPool), null, "Backoff prevents a tight retry loop");
    await wrapper.query(`update filesvc.object_cleanup_jobs set available_at=now() where id=$1`, [job.id]);
    job = await claimObjectCleanup(testPool);
    assert.equal(job.attempts, 2);
    assert.equal(await processObjectCleanup(testPool, job, remove, quiet), "completed");
    assert.ok(removed.includes(`private-files/${network.key}`));

    const protectedVersion = await version(parent);
    await scheduleObjectCleanup(testPool);
    job = await claimObjectCleanup(testPool);
    await wrapper.query(`update filesvc.file_versions set status='available' where id=$1`, [protectedVersion.id]);
    const count = removed.length;
    assert.equal(await processObjectCleanup(testPool, job, remove, quiet), "skipped");
    assert.equal(removed.length, count, "Recheck prevents deleting a newly protected version");

    const renewed = await version(parent);
    await scheduleObjectCleanup(testPool);
    job = await claimObjectCleanup(testPool);
    await wrapper.query(`update filesvc.version_upload_intents set expires_at=$2 where version_id=$1`, [renewed.id, future]);
    assert.equal(await processObjectCleanup(testPool, job, remove, quiet), "deferred");
    assert.ok(!removed.includes(`private-files/${renewed.key}`));

    const lost = await version(parent);
    await scheduleObjectCleanup(testPool);
    job = await claimObjectCleanup(testPool);
    await wrapper.query(`update filesvc.object_cleanup_jobs set available_at=now() where id=$1`, [job.id]);
    const newClaim = await claimObjectCleanup(testPool);
    assert.equal(await processObjectCleanup(testPool, job, remove, quiet), "lost");
    assert.equal(await processObjectCleanup(testPool, newClaim, remove, quiet), "completed");
    assert.ok(removed.includes(`private-files/${lost.key}`));

    const bad = await version(parent);
    await wrapper.query(`update filesvc.file_versions set object_key='outside/allowed/prefix' where id=$1`, [bad.id]);
    assert.equal(await scheduleObjectCleanup(testPool), 0, "Unexpected keys must never be deleted");
    const trash = await initial("deleted", expired, true);
    await version(trash, "upload", "available");
    await wrapper.query(`update filesvc.files set status='deleted',trashed_at=now() where id=$1`, [trash.id]);
    assert.equal(await scheduleObjectCleanup(testPool), 0, "Trash and available history must be retained");
    const events = (await wrapper.query(`select action from filesvc.audit_log where action like 'file.cleanup_%'`)).rows;
    for (const name of ["scheduled", "completed", "skipped", "failed"]) assert.ok(events.some((e) => e.action === `file.cleanup_${name}`));
    if (process.argv.includes("--storage")) {
        const { createClient } = await import("@supabase/supabase-js");
        const storage = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const fixture = await initial();
        const bucket = storage.storage.from("private-files");
        try {
            const uploaded = await bucket.upload(fixture.key, Buffer.from("cleanup smoke"), { contentType: "text/plain", upsert: false });
            if (uploaded.error) throw uploaded.error;
            assert.equal(await scheduleObjectCleanup(testPool), 1);
            const realJob = await claimObjectCleanup(testPool);
            assert.equal(realJob.file_id, fixture.id);
            assert.equal(
                await processObjectCleanup(testPool, realJob, (b, k) => removeStoredObjectIfPresent(storage, b, k), quiet),
                "completed",
            );
            const gone = await bucket.info(fixture.key);
            assert.equal(isMissingStorageObject(gone.error), true);
            await removeStoredObjectIfPresent(storage, "private-files", fixture.key);
            console.log("Storage cleanup check passed: fixture bytes removed and repeated deletion is safe.");
        } finally {
            const result = await bucket.remove([fixture.key]);
            if (result.error) throw result.error;
        }
    }
    console.log(
        "Cleanup checks passed: expiry, active grants, current/history/trash protection, upload/restore/quarantine, audit rollback, retries, leases, key validation and deduplication.",
    );
} finally {
    await client.query("rollback");
    client.release();
    await pool.end();
}
