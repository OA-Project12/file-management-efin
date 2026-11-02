// Pure calculation + PostgreSQL checks. All database fixtures are rolled back.
// node --env-file=.env.local scripts/check-quota-foundation.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Pool } from "pg";
import ts from "typescript";
const require = createRequire(import.meta.url),
    modules = new Map();
function load(file) {
    file = path.resolve(file);
    if (modules.has(file)) return modules.get(file).exports;
    const compiled = { exports: {} };
    modules.set(file, compiled);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function("require", "module", "exports", code)(
        (name) => {
            if (name === "server-only") return {};
            if (name === "./pool")
                return {
                    getDatabasePool: () => {
                        throw new Error("Inject the test connection");
                    },
                };
            if (name.startsWith("@/")) return load(path.join("src", `${name.slice(2)}.ts`));
            if (name.startsWith(".")) return load(path.resolve(path.dirname(file), `${name}.ts`));
            return require(name);
        },
        compiled,
        compiled.exports,
    );
    return compiled.exports;
}
const { calculateDepartmentQuota, checkDepartmentQuotaCapacity, quotaBytes } = load("src/domain/storage/department-quota.ts");
const snapshot = { limitBytes: "100", usedBytes: "60", reservedBytes: "20", revision: "0", initializedAt: new Date() };
assert.equal(calculateDepartmentQuota(snapshot).availableBytes, "20");
assert.equal(checkDepartmentQuotaCapacity(snapshot, "20").allowed, true);
assert.equal(checkDepartmentQuotaCapacity(snapshot, "21").allowed, false);
assert.equal(checkDepartmentQuotaCapacity({ ...snapshot, limitBytes: null }, "9223372036854775807").allowed, true);
assert.equal(calculateDepartmentQuota({ ...snapshot, usedBytes: "101" }).overQuota, true);
assert.equal(calculateDepartmentQuota({ ...snapshot, usedBytes: "101" }).availableBytes, "0");
assert.equal(checkDepartmentQuotaCapacity({ ...snapshot, limitBytes: "0", usedBytes: "0", reservedBytes: "0" }, "1").allowed, false);
assert.equal(
    calculateDepartmentQuota({ ...snapshot, limitBytes: "9007199254740999", usedBytes: "9007199254740993", reservedBytes: "1" })
        .availableBytes,
    "5",
);
for (const value of ["-1", "1.5", "01", "1e3", "9223372036854775808", 1])
    assert.throws(() => quotaBytes(value), { code: "invalid_quota_bytes" });
const unready = { ...snapshot, initializedAt: null };
assert.equal(calculateDepartmentQuota(unready).usedBytes, null);
assert.equal(calculateDepartmentQuota(unready).accountingStatus, "pending_backfill");
assert.throws(() => checkDepartmentQuotaCapacity(unready, "1"), { code: "quota_accounting_not_ready" });

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
const client = await pool.connect();
try {
    await client.query("begin");
    const context = (await client.query("select id,tenant_id from filesvc.applications where status='active' limit 1")).rows[0];
    assert.ok(context);
    const department = (
        await client.query(
            `insert into filesvc.departments (tenant_id,application_id,code,name)
      values ($1,$2,$3,'Quota foundation fixture') returning id`,
            [context.tenant_id, context.id, `quota-${randomUUID()}`],
        )
    ).rows[0];
    const scope = { tenantId: context.tenant_id, applicationId: context.id, departmentId: department.id };
    const { PostgresDepartmentQuotaRepository } = load("src/infrastructure/database/postgres-department-quota-repository.ts");
    const repository = new PostgresDepartmentQuotaRepository(client);
    const seeded = await repository.find(scope);
    assert.ok(seeded, "Department trigger creates quota row");
    assert.equal(seeded.limitBytes, null);
    assert.equal(seeded.initializedAt, null);
    assert.equal(await repository.find({ ...scope, tenantId: randomUUID() }), null);
    assert.equal(await repository.find({ ...scope, applicationId: randomUUID() }), null);
    const { GetDepartmentStorageUsage } = load("src/application/storage/get-department-storage-usage.ts");
    const usage = new GetDepartmentStorageUsage(repository);
    const app = {
        tenantId: context.tenant_id,
        applicationId: context.id,
        keyId: randomUUID(),
        scopes: ["files:read"],
        departments: [{ id: department.id, role: "editor" }],
    };
    assert.equal((await usage.execute(app, department.id)).accountingStatus, "pending_backfill");
    await assert.rejects(usage.execute({ ...app, departments: [{ id: department.id, role: "viewer" }] }, department.id), {
        code: "department_quota_forbidden",
    });
    await assert.rejects(usage.execute({ ...app, scopes: [] }, department.id), { code: "department_quota_forbidden" });
    const key = [context.tenant_id, context.id, department.id];
    await client.query(
        `update filesvc.department_storage_quotas set initialized_at=now(),limit_bytes=100,used_bytes=120
      where tenant_id=$1 and application_id=$2 and department_id=$3`,
        key,
    );
    assert.equal((await usage.execute(app, department.id)).overQuota, true, "Observed physical overage must remain representable");
    async function rejected(sql, values, code) {
        await client.query("savepoint expected_failure");
        try {
            await assert.rejects(client.query(sql, values), { code });
        } finally {
            await client.query("rollback to savepoint expected_failure");
            await client.query("release savepoint expected_failure");
        }
    }
    await rejected(`update filesvc.department_storage_quotas set used_bytes=-1 where department_id=$1`, [department.id], "23514");
    const file = (
        await client.query("select id from filesvc.files where tenant_id=$1 and application_id=$2 limit 1", [context.tenant_id, context.id])
    ).rows[0];
    const params = [...key, file.id, randomUUID()];
    const insert = `insert into filesvc.storage_allocations
      (tenant_id,application_id,department_id,file_id,kind,bucket_id,object_key,reserved_bytes)
      values ($1,$2,$3,$4,'initial_upload','quota-fixture',$5,10)`;
    await client.query(insert, params);
    await rejected(insert, params, "23505");
    await rejected(insert, [...key, randomUUID(), randomUUID()], "23503");
    await rejected(`update filesvc.storage_allocations set state='released' where object_key=$1`, [params[4]], "23514");
    await client.query(`update filesvc.storage_allocations set state='released',reserved_bytes=0,released_at=now() where object_key=$1`, [
        params[4],
    ]);
    await rejected(`update filesvc.storage_allocations set charged_bytes=-1 where object_key=$1`, [params[4]], "23514");
    await client.query(`update filesvc.departments set status='suspended' where id=$1`, [department.id]);
    assert.equal(await repository.find(scope), null);
    console.log(
        "Quota foundation checks passed: bigint precision, unlimited/zero/overage, pending backfill, trigger, tenant/app scoping, roles, deduplication and database constraints.",
    );
} finally {
    await client.query("rollback");
    client.release();
    await pool.end();
}
