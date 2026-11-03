// Storage is simulated; real SQL runs only on TEMP tables, then rolls back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import { Pool } from "pg";
import { inspectQuota, readQuotaSnapshot, applyQuotaDepartment, objectId, bytes, storageInspector } from "./quota-reconciliation.mjs";
import {
    enterStorageMutation,
    acquireStorageMaintenance,
    maintenancePaths,
    storageMaintenanceEnabled,
    isStorageMutation,
} from "../src/infrastructure/storage/storage-maintenance.mjs";

const scope = { tenantId: randomUUID(), applicationId: randomUUID() },
    dept = randomUUID(),
    other = randomUUID(),
    now = "2026-11-02T00:00:00.000Z";
function fixture() {
    return {
        departments: [dept, other].map((id) => ({ id, ...scope, status: "active" })),
        quotas: [dept, other].map((department_id) => ({
            department_id,
            limit_bytes: null,
            used_bytes: "0",
            reserved_bytes: "0",
            revision: "0",
            initialized_at: null,
        })),
        files: [],
        versions: [],
        uploads: [],
        versionUploads: [],
        restores: [],
        allocations: [],
        cleanup: [],
    };
}
function file(s, { department = dept, size = "10", status = "available", trashed = false } = {}) {
    const id = randomUUID(),
        row = {
            id,
            department_id: department,
            bucket_id: "private-files",
            object_key: `${scope.tenantId}/${scope.applicationId}/${id}`,
            size_bytes: size,
            status,
            trashed_at: trashed ? now : null,
            current_version_id: null,
            updated_at: now,
        };
    s.files.push(row);
    return row;
}
function version(s, f, { size = f.size_bytes, status = "available", original = false } = {}) {
    const id = randomUUID(),
        row = {
            id,
            file_id: f.id,
            bucket_id: f.bucket_id,
            object_key: original ? f.object_key : `${f.object_key}/versions/${id}`,
            size_bytes: size,
            status,
            completed_at: status === "available" ? now : null,
        };
    s.versions.push(row);
    return row;
}
function objects(rows) {
    const physical = new Map(rows.map((r) => [objectId(r), { size: r.size_bytes }]));
    return {
        physical,
        info: async (bucket, key) => physical.get(JSON.stringify([bucket, key])) ?? null,
        inventory: async () =>
            [...physical.keys()].map((k) => {
                const [bucket_id, object_key] = JSON.parse(k);
                return { bucket_id, object_key };
            }),
    };
}
const options = { mode: "backfill" };
const clean = async (s, storage) => inspectQuota(s, scope, storage, options);
const forDept = (p) => p.departments.find((d) => d.departmentId === dept);
const s = fixture(),
    f = file(s),
    v1 = version(s, f, { original: true });
f.current_version_id = v1.id;
const v2 = version(s, f, { size: "20" }),
    trash = file(s, { size: "7", status: "deleted", trashed: true }),
    purged = file(s, { status: "deleted" });
const pending = file(s, { size: "11", status: "pending_upload" });
s.uploads.push({ file_id: pending.id, expires_at: now, completed_at: null });
const failed = version(s, f, { size: "4", status: "failed" });
s.restores.push({ file_id: f.id, version_id: failed.id, expires_at: now, completed_at: null });
const cleaned = file(s, { status: "failed" });
s.cleanup.push({ file_id: cleaned.id, version_id: null, kind: "initial_upload" });
const storage = objects([f, v2, trash, pending, failed]);
let plan = await clean(s, storage),
    department = forDept(plan);
assert.equal(department.canApply, true);
assert.equal(department.usedBytes, "41");
assert.equal(department.reservedBytes, "11");
assert.equal(department.proposals.length, 7, "Current object and v1 are deduplicated");
assert.equal(department.proposals.find((p) => p.file_id === purged.id).state, "released");
assert.equal(department.proposals.find((p) => p.file_id === pending.id).state, "reserved", "Presence does not complete an upload");
assert.equal(department.proposals.find((p) => p.version_id === failed.id).state, "release_pending");
assert.equal(department.proposals.find((p) => p.file_id === cleaned.id).state, "released");
assert.equal(forDept(await clean(s, storage)).proposals.find((p) => p.file_id === purged.id).released_at, now);
const broken = structuredClone(s);
broken.files.find((x) => x.id === trash.id).size_bytes = "8";
assert.equal(forDept(await clean(broken, storage)).canApply, false);
assert.equal((await clean(broken, storage)).departments.find((d) => d.departmentId === other).canApply, true);
storage.physical.delete(objectId(f));
assert.ok(forDept(await clean(s, storage)).issues.some((i) => i.code === "available_object_missing"));
storage.physical.set(objectId(f), { size: "10" });
const stray = { bucket_id: f.bucket_id, object_key: `${f.object_key}/stray` };
storage.physical.set(objectId(stray), { size: "1" });
assert.ok(forDept(await clean(s, storage)).issues.some((i) => i.code === "unreferenced_storage_object"));
storage.physical.delete(objectId(stray));
const unknown = { bucket_id: f.bucket_id, object_key: `${scope.tenantId}/${scope.applicationId}/${randomUUID()}` };
storage.physical.set(objectId(unknown), { size: "1" });
assert.ok((await clean(s, storage)).departments.every((d) => !d.canApply));
storage.physical.delete(objectId(unknown));
assert.ok(
    (
        await clean(s, {
            ...storage,
            inventory: async () => {
                throw new Error("timeout");
            },
        })
    ).departments.every((d) => !d.canApply),
);
assert.equal(
    forDept(
        await clean(s, {
            ...storage,
            info: async () => {
                throw new Error("timeout");
            },
        }),
    ).canApply,
    false,
);
const big = fixture(),
    bigFile = file(big, { size: "9007199254740993" });
assert.equal(forDept(await clean(big, objects([bigFile]))).usedBytes, "9007199254740993");
assert.throws(() => bytes(9007199254740992), /invalid_storage_size/);
assert.ok(forDept(await inspectQuota(s, scope, storage, { mode: "reconcile" })).issues.some((i) => i.code === "allocation_missing"));
const ledger = structuredClone(s);
ledger.allocations = department.proposals.map((p) => ({ ...p, id: randomUUID() }));
assert.equal(forDept(await clean(ledger, storage)).canApply, true);
ledger.allocations.find((a) => a.state === "stored").department_id = other;
assert.ok((await clean(ledger, storage)).departments.every((d) => !d.canApply));
// Missing physical bytes do not erase a pending worker debt.
const debt = structuredClone(s);
debt.allocations = department.proposals.map((p) => ({ ...p, id: randomUUID() }));
storage.physical.delete(objectId(failed));
assert.equal(forDept(await clean(debt, storage)).usedBytes, "41");
storage.physical.set(objectId(failed), { size: "4" });
const missing404 = storageInspector(
    { storage: { from: () => ({ info: async () => ({ error: { status: 400, statusCode: "404" } }) }) } },
    "private-files",
);
assert.equal(await missing404.info("private-files", "fixture"), null);
let pageCalls = 0;
const paged = storageInspector(
    {
        storage: {
            from: () => ({
                list: async (prefix, { offset }) => {
                    pageCalls++;
                    return {
                        data:
                            offset === 0
                                ? Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: String(i) }))
                                : [{ id: "last", name: "last" }],
                    };
                },
            }),
        },
    },
    "private-files",
);
assert.equal((await paged.inventory(scope, [])).length, 1001);
assert.equal(pageCalls, 2);

// Exercise the actual route wrapper: denied mutations never invoke the handler;
// read-only POST routes remain usable even with environment maintenance enabled.
const require = createRequire(import.meta.url);
const control = mkdtempSync(path.join(tmpdir(), "quota-maintenance-"));
const previousControl = process.env.STORAGE_QUOTA_CONTROL_DIR,
    previousFlag = process.env.STORAGE_QUOTA_MAINTENANCE;
process.env.STORAGE_QUOTA_CONTROL_DIR = control;
delete process.env.STORAGE_QUOTA_MAINTENANCE;
try {
    const release = enterStorageMutation();
    assert.equal(typeof release, "function");
    let drained = false;
    const acquiring = acquireStorageMaintenance(2000).then((r) => {
        drained = true;
        return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(drained, false);
    assert.equal(enterStorageMutation(), null);
    release();
    const unlock = await acquiring;
    assert.equal(storageMaintenanceEnabled(), true);
    assert.equal(enterStorageMutation(), null);
    unlock();
    assert.equal(existsSync(maintenancePaths().lock), false);
    process.env.STORAGE_QUOTA_MAINTENANCE = "1";
    const mod = { exports: {} };
    const code = ts.transpileModule(readFileSync("src/infrastructure/audit/audit-route.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "module", "exports", code)(
        (name) => {
            if (name === "server-only") return {};
            if (name.includes("application-key-authenticator")) return { authenticateApplicationKey: async () => ({}) };
            if (name.includes("record-audit")) return { auditRequestContext: { run: (_, fn) => fn() }, recordAudit: async () => {} };
            if (name.includes("storage-maintenance")) return { enterStorageMutation, isStorageMutation };
            return require(name);
        },
        mod,
        mod.exports,
    );
    let invoked = 0;
    const handler = async () => {
        invoked++;
        return Response.json({ ok: true });
    };
    for (const action of [
        "file.upload_intent",
        "file.version_restore",
        "file.metadata_update",
        "file.trash",
        "file.restore",
        "file.purge_requested",
        "folder.create",
        "folder.access_update",
        "department.create",
    ]) {
        const response = await mod.exports.auditRoute(action, "file", handler, { recordSuccess: false })(
            new Request("http://example.test", { method: "POST" }),
        );
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, "storage_maintenance");
    }
    assert.equal(invoked, 0);
    for (const action of [
        "file.search",
        "file.preview_url",
        "file.download_url",
        "file.version_preview_url",
        "file.version_download_url",
        "file.versions_read",
    ])
        assert.equal(
            (
                await mod.exports.auditRoute(action, "file", handler, { recordSuccess: false })(
                    new Request("http://example.test", { method: "POST" }),
                )
            ).status,
            200,
        );
    assert.equal(invoked, 6);
} finally {
    if (previousControl === undefined) delete process.env.STORAGE_QUOTA_CONTROL_DIR;
    else process.env.STORAGE_QUOTA_CONTROL_DIR = previousControl;
    if (previousFlag === undefined) delete process.env.STORAGE_QUOTA_MAINTENANCE;
    else process.env.STORAGE_QUOTA_MAINTENANCE = previousFlag;
    if (path.dirname(path.resolve(control)) !== path.resolve(tmpdir()) || !path.basename(control).startsWith("quota-maintenance-"))
        throw new Error("Unexpected test directory");
    rmSync(control, { recursive: true, force: true });
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
let serial = 0,
    failAudit = false,
    failDatabase = false;
const stack = [];
const wrapped = {
    async query(sql, values) {
        if (sql === "begin") {
            const name = `q_${++serial}`;
            stack.push(name);
            return client.query(`savepoint ${name}`);
        }
        if (sql === "commit") return client.query(`release savepoint ${stack.pop()}`);
        if (sql === "rollback") {
            const name = stack.pop();
            await client.query(`rollback to savepoint ${name}`);
            return client.query(`release savepoint ${name}`);
        }
        if (failAudit && sql.includes("insert into filesvc.audit_log")) throw new Error("audit_failure");
        if (failDatabase && sql.includes("update filesvc.department_storage_quotas")) throw new Error("database_failure");
        return client.query(sql.replaceAll("filesvc.", "pg_temp."), values);
    },
    release() {},
};
const testPool = { connect: async () => wrapped, query: (...a) => wrapped.query(...a) };
try {
    await client.query("begin");
    for (const name of [
        "departments",
        "department_storage_quotas",
        "files",
        "file_versions",
        "upload_intents",
        "version_upload_intents",
        "version_restore_intents",
        "storage_allocations",
        "audit_log",
    ])
        await client.query(`create temp table ${name} (like filesvc.${name} including all) on commit drop`);
    for (const id of [dept, other]) {
        await wrapped.query("insert into filesvc.departments(id,tenant_id,application_id,code,name) values ($1,$2,$3,$4,$4)", [
            id,
            scope.tenantId,
            scope.applicationId,
            id,
        ]);
        await wrapped.query("insert into filesvc.department_storage_quotas(tenant_id,application_id,department_id) values ($1,$2,$3)", [
            scope.tenantId,
            scope.applicationId,
            id,
        ]);
    }
    const insertFile = async (row) =>
        wrapped.query(
            `insert into filesvc.files(id,tenant_id,application_id,department_id,owner_subject,bucket_id,object_key,original_name,display_name,content_type,size_bytes,status,trashed_at)
        values ($1,$2,$3,$4,'fixture',$5,$6,'fixture','fixture','text/plain',$7::bigint,$8,$9)`,
            [
                row.id,
                scope.tenantId,
                scope.applicationId,
                row.department_id,
                row.bucket_id,
                row.object_key,
                row.size_bytes,
                row.status,
                row.trashed_at,
            ],
        );
    for (const row of s.files) await insertFile(row);
    for (const v of s.versions)
        await wrapped.query(
            `insert into filesvc.file_versions(id,file_id,version_number,bucket_id,object_key,original_name,content_type,size_bytes,status,created_by_kind)
      select $1,$2,coalesce(max(version_number),0)+1,$3,$4,'fixture','text/plain',$5::bigint,$6,'migration' from filesvc.file_versions where file_id=$2`,
            [v.id, v.file_id, v.bucket_id, v.object_key, v.size_bytes, v.status],
        );
    for (const i of s.uploads)
        await wrapped.query("insert into filesvc.upload_intents(file_id,token_fingerprint,expires_at) values ($1,$2,$3)", [
            i.file_id,
            Buffer.alloc(32),
            i.expires_at,
        ]);
    await wrapped.query("insert into filesvc.version_restore_intents(file_id,version_id,base_version_id,expires_at) values ($1,$2,$3,$4)", [
        f.id,
        failed.id,
        v1.id,
        now,
    ]);
    await wrapped.query(
        `insert into filesvc.audit_log(tenant_id,application_id,actor_kind,action,outcome,resource_type,resource_id,request_id,details)
      values ($1,$2,'worker','file.cleanup_completed','success','file',$3,$4,$5::jsonb)`,
        [scope.tenantId, scope.applicationId, cleaned.id, randomUUID(), JSON.stringify({ versionId: null, kind: "initial_upload" })],
    );
    const snapshot = await readQuotaSnapshot(testPool, scope),
        dbPlan = await clean(snapshot, storage),
        dbDept = forDept(dbPlan);
    assert.equal(dbDept.canApply, true);
    assert.equal(dbDept.usedBytes, "41");
    assert.equal((await readQuotaSnapshot(testPool, { ...scope, tenantId: randomUUID() })).files.length, 0);
    assert.equal((await readQuotaSnapshot(testPool, { ...scope, applicationId: randomUUID() })).files.length, 0);
    assert.equal((await wrapped.query("select count(*) from filesvc.storage_allocations")).rows[0].count, "0", "Dry run has no writes");
    assert.equal(
        await applyQuotaDepartment(
            testPool,
            scope,
            snapshot,
            dbPlan.departments.find((d) => d.departmentId === other),
        ),
        "applied",
    );
    failAudit = true;
    await assert.rejects(applyQuotaDepartment(testPool, scope, snapshot, dbDept), /audit_failure/);
    failAudit = false;
    assert.equal((await wrapped.query("select count(*) from filesvc.storage_allocations")).rows[0].count, "0");
    assert.equal(
        (await wrapped.query("select initialized_at from filesvc.department_storage_quotas where department_id=$1", [dept])).rows[0]
            .initialized_at,
        null,
    );
    assert.ok(
        (await wrapped.query("select initialized_at from filesvc.department_storage_quotas where department_id=$1", [other])).rows[0]
            .initialized_at,
        "Another department remains committed",
    );
    failDatabase = true;
    await assert.rejects(applyQuotaDepartment(testPool, scope, snapshot, dbDept), /database_failure/);
    failDatabase = false;
    assert.equal((await wrapped.query("select count(*) from filesvc.storage_allocations")).rows[0].count, "0");
    await wrapped.query("update filesvc.files set updated_at=updated_at+interval '1 second' where id=$1", [f.id]);
    await assert.rejects(applyQuotaDepartment(testPool, scope, snapshot, dbDept), /quota_snapshot_changed/);
    let current = await readQuotaSnapshot(testPool, scope),
        currentDept = forDept(await clean(current, storage));
    assert.equal(await applyQuotaDepartment(testPool, scope, current, currentDept), "applied");
    current = await readQuotaSnapshot(testPool, scope);
    currentDept = forDept(await clean(current, storage));
    assert.equal(currentDept.canApply, true);
    assert.equal(await applyQuotaDepartment(testPool, scope, current, currentDept), "unchanged");
    assert.equal(current.allocations.length, 7);
    // Reconcile repairs only counters when the complete ledger is already valid.
    await wrapped.query("update filesvc.department_storage_quotas set used_bytes=1 where department_id=$1", [dept]);
    current = await readQuotaSnapshot(testPool, scope);
    currentDept = forDept(await inspectQuota(current, scope, storage, { mode: "reconcile" }));
    assert.equal(currentDept.counterDrift, true);
    assert.equal(currentDept.canApply, true);
    assert.equal(await applyQuotaDepartment(testPool, scope, current, currentDept, { mode: "reconcile" }), "applied");
    assert.equal(
        (
            await wrapped.query(
                "select used_bytes::text,reserved_bytes::text from filesvc.department_storage_quotas where department_id=$1",
                [dept],
            )
        ).rows[0].used_bytes,
        "41",
    );
    console.log(
        "Quota reconciliation checks passed: deduplication, versions/trash/purge, pending grants, cleanup receipts, missing/mismatched/orphan objects, BigInt, maintenance drain/read access, tenant scope, dry run, audit rollback, stale snapshot, idempotence and counter repair.",
    );
} finally {
    await client.query("rollback");
    client.release();
    await pool.end();
}
