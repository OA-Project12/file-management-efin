// Database integration checks. All fixtures and audit rows are rolled back.
// Run: node --env-file=.env.local scripts/check-version-repository.mjs
// Add --storage to also copy/download/remove isolated Storage objects under the fixture UUID.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Pool } from "pg";
import ts from "typescript";

const require = createRequire(import.meta.url);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
let failAudit = false;
let failAuditAction = "";
let requestApp;
let failCopy = false;
let onCopy;
const objects = new Map();
class TestStorage {
    async getObjectInfo(bucket, key) {
        return objects.get(`${bucket}/${key}`) ?? null;
    }
    async copyObject(bucket, source, target) {
        if (failCopy) throw new Error("injected copy failure");
        const info = await this.getObjectInfo(bucket, source);
        assert.ok(info);
        objects.set(`${bucket}/${target}`, { ...info });
        if (onCopy) await onCopy();
    }
    async deleteObject(bucket, key) {
        objects.delete(`${bucket}/${key}`);
    }
    async createPreviewGrant() {
        return { signedUrl: "https://example.invalid/?token=do-not-log", expiresInSeconds: 300 };
    }
    async createDownloadGrant() {
        return this.createPreviewGrant();
    }
}
let savepoint = 0;
const stack = [];
const scopedClient = {
    async query(sql, values) {
        if (sql === "begin") {
            const name = `check_${++savepoint}`;
            stack.push(name);
            return client.query(`savepoint ${name}`);
        }
        if (sql === "commit") return client.query(`release savepoint ${stack.pop()}`);
        if (sql === "rollback") {
            const name = stack.pop();
            await client.query(`rollback to savepoint ${name}`);
            return client.query(`release savepoint ${name}`);
        }
        if ((failAudit || (failAuditAction && values?.[4] === failAuditAction)) && sql.includes("insert into filesvc.audit_log"))
            throw new Error("injected audit failure");
        return client.query(sql.replaceAll("filesvc.department_storage_quotas","pg_temp.version_test_quotas")
            .replaceAll("filesvc.storage_allocations","pg_temp.version_test_allocations"), values);
    },
    release() {},
};
const scopedPool = { connect: async () => scopedClient, query: (...args) => scopedClient.query(...args) };
const modules = new Map();
// Execute the actual TS repositories with only the pool replaced by one rollback-only connection.
function load(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const compiledModule = { exports: {} };
    modules.set(filename, compiledModule);
    const js = ts.transpileModule(readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const resolve = (name) => {
        if (name === "server-only") return {};
        if (name === "next/server") return { connection: async () => undefined };
        if (name === "@/infrastructure/auth/application-key-authenticator") return { authenticateApplicationKey: async () => requestApp };
        if (name === "@/infrastructure/storage/supabase-object-storage") return { SupabaseObjectStorage: TestStorage };
        if (name === "./pool" || name === "@/infrastructure/database/pool") return { getDatabasePool: () => scopedPool };
        if (name.startsWith("@/")) return load(path.join("src", name.endsWith('.mjs')?name.slice(2):`${name.slice(2)}.ts`));
        if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
        return require(name);
    };
    new Function("require", "module", "exports", js)(resolve, compiledModule, compiledModule.exports);
    return compiledModule.exports;
}

try {
    await client.query("begin");
    const context = (await client.query(`select tenant_id, application_id, department_id, bucket_id from filesvc.files limit 1`)).rows[0];
    assert.ok(context, "A department/file context is required for rollback-only fixtures");
    const app = {
        keyId: randomUUID(),
        tenantId: context.tenant_id,
        applicationId: context.application_id,
        scopes: ["files:read", "files:write"],
        departments: [{ id: context.department_id, role: "admin" }],
    };
    const scope = { app, ownerSubject: "version-smoke" };
    // Avoid holding a real department's quota row lock throughout this rollback-only suite.
    await client.query("create temp table version_test_quotas (like filesvc.department_storage_quotas including all) on commit drop");
    await client.query("create temp table version_test_allocations (like filesvc.storage_allocations including all) on commit drop");
    await client.query("insert into version_test_quotas (tenant_id,application_id,department_id) values ($1,$2,$3)",[app.tenantId,app.applicationId,context.department_id]);
    const fileId = randomUUID();
    const baseKey = `${app.tenantId}/${app.applicationId}/${fileId}`;
    const { PostgresUploadIntentRepository } = load("src/infrastructure/database/postgres-upload-intent-repository.ts");
    const original = new PostgresUploadIntentRepository(scopedPool);
    await original.createPendingUpload({
        auditActor: app,
        fileId,
        tenantId: app.tenantId,
        applicationId: app.applicationId,
        departmentId: context.department_id,
        ownerSubject: scope.ownerSubject,
        bucketId: context.bucket_id,
        objectKey: baseKey,
        originalName: "v1.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        checksumSha256: null,
        tokenFingerprint: Buffer.alloc(32),
        expiresInSeconds: 7200,
    });
    assert.equal(
        await original.completeUpload(app, fileId, app.tenantId, app.applicationId, [context.department_id], 3, "text/plain"),
        true,
    );
    const { PostgresFileVersionRepository } = load("src/infrastructure/database/postgres-file-version-repository.ts");
    const repository = new PostgresFileVersionRepository();
    const page = await repository.list(fileId, scope, 1, null);
    const v1 = page.currentVersionId;
    assert.ok(v1);
    assert.equal(page.items[0].versionNumber, 1);
    const create = async (base, sizeBytes = 4) => {
        const id = randomUUID();
        await repository.create(fileId, scope, {
            versionId: id,
            expectedCurrentVersionId: base,
            bucketId: context.bucket_id,
            objectKey: `${baseKey}/versions/${id}`,
            originalName: "revised.txt",
            contentType: "text/plain",
            sizeBytes,
            checksumSha256: null,
        });
        return id;
    };
    const v2 = await create(v1);
    const stale = await create(v1);
    await repository.complete(fileId, v2, scope, 4, "text/plain", false);
    await assert.rejects(repository.complete(fileId, stale, scope, 4, "text/plain", false), { code: "version_conflict" });
    await assert.rejects(create(v1), { code: "version_conflict" });
    const v4 = await create(v2, 5);
    failAudit = true;
    await assert.rejects(repository.complete(fileId, v4, scope, 5, "text/plain", false), /injected audit failure/);
    failAudit = false;
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, v2);
    assert.equal((await repository.find(fileId, v4, scope)).status, "pending_upload");
    await repository.complete(fileId, v4, scope, 5, "text/plain", false);
    await repository.complete(fileId, v2, scope, 4, "text/plain", false);
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, v4);
    const cached = (await client.query("select object_key,size_bytes from filesvc.files where id=$1", [fileId])).rows[0];
    assert.equal(cached.object_key, `${baseKey}/versions/${v4}`);
    assert.equal(cached.size_bytes, "5");
    const viewer = { ...scope, app: { ...app, departments: [{ id: context.department_id, role: "viewer" }] } };
    assert.equal((await repository.list(fileId, viewer, 1, null)).items.length, 1);
    await assert.rejects(repository.find(fileId, v4, viewer), { code: "file_not_found" });
    await assert.rejects(repository.list(fileId, { ...scope, ownerSubject: "another-owner" }, 25, null), { code: "file_not_found" });
    await assert.rejects(repository.list(fileId, { ...scope, app: { ...app, tenantId: randomUUID() } }, 25, null), {
        code: "file_not_found",
    });
    const paged = await repository.list(fileId, scope, 1, null);
    assert.ok(paged.nextCursor);
    const next = await repository.list(fileId, scope, 1, Number(paged.nextCursor));
    assert.notEqual(next.items[0].id, paged.items[0].id);
    const oversized = await create(v4);
    await repository.complete(fileId, oversized, scope, 999, "text/plain", true);
    assert.equal((await repository.find(fileId, oversized, scope)).status, "quarantined");
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, v4);
    assert.equal((await repository.findAvailable(fileId, v1, viewer)).id, v1);
    await assert.rejects(repository.findAvailable(fileId, oversized, scope), { code: "version_not_found" });
    await assert.rejects(repository.findAvailable(fileId, randomUUID(), scope), { code: "version_not_found" });
    await assert.rejects(repository.findAvailable(fileId, v1, { ...scope, app: { ...app, applicationId: randomUUID() } }), {
        code: "file_not_found",
    });

    const handlers = load("src/infrastructure/http/file-version-handlers.ts");
    requestApp = app;
    const contextFor = (versionId) => ({ params: Promise.resolve({ fileId, versionId }) });
    const req = (extra = {}) =>
        new Request("http://example.test/api/v1/files/test", {
            method: "POST",
            body: JSON.stringify({ ownerSubject: scope.ownerSubject, ...extra }),
        });
    objects.set(`${context.bucket_id}/${baseKey}`, { sizeBytes: 3, contentType: "text/plain" });
    const preview = await handlers.previewVersion(req(), contextFor(v1));
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).data.versionId, v1);
    assert.equal((await handlers.downloadVersion(req(), contextFor(v1))).status, 200);
    failAuditAction = "file.version_preview_url";
    const noAudit = await handlers.previewVersion(req(), contextFor(v1));
    assert.equal(noAudit.status, 503);
    assert.equal(JSON.stringify(await noAudit.json()).includes("signedUrl"), false);
    failAuditAction = "";
    assert.equal((await handlers.previewVersion(req(), contextFor(v4))).status, 409); // object absent
    objects.get(`${context.bucket_id}/${baseKey}`).contentType = "text/html";
    assert.equal((await handlers.previewVersion(req(), contextFor(v1))).status, 415);
    objects.get(`${context.bucket_id}/${baseKey}`).contentType = "text/plain";
    requestApp = viewer.app;
    assert.equal((await handlers.previewVersion(req(), contextFor(v1))).status, 200);
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: v4 }), contextFor(v1))).status, 404);
    requestApp = app;
    const restoredResponse = await handlers.restoreVersion(req({ expectedCurrentVersionId: v4 }), contextFor(v1));
    assert.equal(restoredResponse.status, 201);
    const restored = (await restoredResponse.json()).data;
    assert.notEqual(restored.versionId, v1);
    assert.equal(restored.restoredFromVersionId, v1);
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, restored.versionId);
    assert.equal((await repository.list(fileId, scope, 25, null)).items[0].restoredFromVersionId, v1);
    assert.equal(await repository.failRestore(fileId, restored.versionId, scope, "test"), false);
    assert.ok(objects.has(`${context.bucket_id}/${baseKey}`));
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: v4 }), contextFor(v1))).status, 409);
    assert.equal(
        (await handlers.restoreVersion(req({ expectedCurrentVersionId: restored.versionId }), contextFor(restored.versionId))).status,
        409,
    );

    failAuditAction = "file.version_restore";
    const auditRestore = await handlers.restoreVersion(req({ expectedCurrentVersionId: restored.versionId }), contextFor(v1));
    assert.equal(auditRestore.status, 503);
    failAuditAction = "";
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, restored.versionId);
    failCopy = true;
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: restored.versionId }), contextFor(v1))).status, 503);
    failCopy = false;
    assert.equal((await repository.list(fileId, scope, 25, null)).items[0].status, "failed");
    let concurrent;
    onCopy = async () => {
        concurrent = await create(restored.versionId);
        await repository.complete(fileId, concurrent, scope, 4, "text/plain", false);
    };
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: restored.versionId }), contextFor(v1))).status, 409);
    onCopy = undefined;
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, concurrent);
    onCopy = async () => {
        requestApp = viewer.app;
    };
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: concurrent }), contextFor(v1))).status, 404);
    assert.equal((await repository.list(fileId, scope, 25, null)).currentVersionId, concurrent);
    onCopy = undefined;
    requestApp = app;
    const expiredId = randomUUID();
    await repository.reserveRestore(fileId, v1, scope, {
        versionId: expiredId,
        expectedCurrentVersionId: concurrent,
        objectKey: `${baseKey}/versions/${expiredId}`,
        sizeBytes: 3,
        contentType: "text/plain",
    });
    await client.query("update filesvc.version_restore_intents set expires_at=now()-interval '1 minute' where version_id=$1", [expiredId]);
    await assert.rejects(repository.completeRestore(fileId, expiredId, scope), { code: "restore_expired" });
    assert.equal(await repository.failRestore(fileId, expiredId, scope, "restore_expired"), true);
    requestApp = { ...app, userId: randomUUID(), isTenantAdmin: false };
    assert.equal((await handlers.previewVersion(req({ ownerSubject: "ignored-for-auth-users" }), contextFor(v1))).status, 200);
    requestApp = { ...requestApp, departments: [{ id: context.department_id, role: "viewer" }] };
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: concurrent }), contextFor(v1))).status, 404);
    requestApp = app;
    const details = (await client.query("select details from filesvc.audit_log where resource_id=$1", [fileId])).rows;
    assert.equal(JSON.stringify(details).includes("do-not-log"), false);
    await client.query("update filesvc.files set status='deleted',trashed_at=now() where id=$1", [fileId]);
    assert.equal((await handlers.previewVersion(req(), contextFor(v1))).status, 404);
    assert.equal((await handlers.restoreVersion(req({ expectedCurrentVersionId: concurrent }), contextFor(v1))).status, 404);

    if (process.argv.includes("--storage")) {
        const { createClient } = require("@supabase/supabase-js");
        const sdk = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const bucket = sdk.storage.from(context.bucket_id);
        const destination = `${baseKey}/versions/${randomUUID()}`;
        const { SupabaseObjectStorage } = load("src/infrastructure/storage/supabase-object-storage.ts");
        const realStorage = new SupabaseObjectStorage();
        try {
            const uploaded = await bucket.upload(baseKey, Buffer.from("version restore smoke"), {
                contentType: "text/plain",
                upsert: false,
            });
            if (uploaded.error) throw uploaded.error;
            await realStorage.copyObject(context.bucket_id, baseKey, destination);
            const source = await bucket.download(baseKey);
            const copied = await bucket.download(destination);
            if (source.error || copied.error) throw source.error ?? copied.error;
            assert.equal(await copied.data.text(), await source.data.text());
            assert.deepEqual(
                await realStorage.getObjectInfo(context.bucket_id, destination),
                await realStorage.getObjectInfo(context.bucket_id, baseKey),
            );
            console.log("Storage copy check passed: independent object with identical bytes; source preserved.");
        } finally {
            const removed = await bucket.remove([baseKey, destination]);
            if (removed.error) throw removed.error;
        }
    }
    console.log(
        "Version checks passed: uploads, preview/download, restore, conflicts, retries, audit rollback, isolation, roles, pagination, quarantine and trash.",
    );
} finally {
    await client.query("rollback");
    client.release();
    await pool.end();
}
