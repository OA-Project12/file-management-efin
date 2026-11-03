// Real PostgreSQL TEMP fixtures and simulated identities. Nothing is committed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { Pool } from "pg";
const require = createRequire(import.meta.url),
    cache = new Map();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 }),
    client = await pool.connect();
let serial = 0,
    lastListQuery;
const stack = [];
const wrapped = {
    async query(sql, values) {
        if (sql === "begin") {
            const name = `search_${++serial}`;
            stack.push(name);
            return client.query(`savepoint ${name}`);
        }
        if (sql === "commit") return client.query(`release savepoint ${stack.pop()}`);
        if (sql === "rollback") {
            const name = stack.pop();
            await client.query(`rollback to savepoint ${name}`);
            return client.query(`release savepoint ${name}`);
        }
        const rewritten = sql.replaceAll("filesvc.", "pg_temp.");
        if (sql.includes("from filesvc.files f") && sql.includes("order by f.created_at desc")) lastListQuery = { sql: rewritten, values };
        return client.query(rewritten, values);
    },
    release() {},
};
const testPool = { query: (...args) => wrapped.query(...args), connect: async () => wrapped };
const tenant = randomUUID(),
    application = randomUUID(),
    dept = randomUUID(),
    otherDept = randomUUID(),
    user = randomUUID(),
    parent = randomUUID(),
    child = randomUUID(),
    publicFolder = randomUUID();
const identity = {
    tenantId: tenant,
    applicationId: application,
    keyId: "",
    userId: user,
    isTenantAdmin: false,
    scopes: ["files:read", "files:write"],
    departments: [{ id: dept, role: "viewer" }],
};
let app = identity;
function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const compiled = { exports: {} };
    cache.set(file, compiled);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "module", "exports", code)(
        (name) => {
            if (name === "server-only") return {};
            if (name === "@/infrastructure/database/pool" || name === "./pool") return { getDatabasePool: () => testPool };
            if (name === "@/infrastructure/auth/application-key-authenticator") return { authenticateApplicationKey: async () => app };
            if (name.startsWith("@/")) return load(path.join("src", name.endsWith(".mjs") ? name.slice(2) : `${name.slice(2)}.ts`));
            if (name.startsWith(".")) return load(path.resolve(path.dirname(file), `${name}.ts`));
            return require(name);
        },
        compiled,
        compiled.exports,
    );
    return compiled.exports;
}
const { POST } = load("src/app/api/v1/files/search/route.ts");
const { PATCH } = load("src/app/api/v1/files/[fileId]/metadata/route.ts");
const { normalizeFileSearchQuery, fileSearchPatterns } = load("src/domain/files/file-search-query.ts");
assert.equal(normalizeFileSearchQuery("  งบ\n 2569\t "), "งบ 2569");
assert.equal(normalizeFileSearchQuery(null), "");
assert.deepEqual(fileSearchPatterns("% _ \\"), ["%\\%%", "%\\_%", "%\\\\%"]);
const call = (body) => POST(new Request("http://fixture/api/v1/files/search", { method: "POST", body: JSON.stringify(body) }));
async function search(body = {}) {
    const response = await call(body);
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    return (await response.json()).data;
}
const ids = (result) => result.items.map((i) => i.id);
async function error(body, code) {
    const response = await call(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
}
async function insertFile({
    name = "รายงานงบการเงิน.pdf",
    display = name,
    tags = ["2569", "Finance"],
    folder = null,
    status = "available",
    owner = "owner-A",
    tenantId = tenant,
    applicationId = application,
    departmentId = dept,
    type = "application/pdf",
    createdAt = "2026-11-03T00:00:00.123Z",
} = {}) {
    const id = randomUUID();
    await wrapped.query(
        `insert into filesvc.files(id,tenant_id,application_id,department_id,owner_subject,bucket_id,object_key,original_name,display_name,content_type,size_bytes,status,folder_id,tags,created_at,deleted_at,trashed_at)
      values ($1,$2,$3,$4,$5,'private-files',$6,$7,$8,$9,12,$10,$11,$12,$13,$14,$14)`,
        [
            id,
            tenantId,
            applicationId,
            departmentId,
            owner,
            `${tenantId}/${applicationId}/${id}`,
            name,
            display,
            type,
            status,
            folder,
            tags,
            createdAt,
            status === "deleted" ? new Date() : null,
        ],
    );
    return id;
}
try {
    await client.query("begin");
    for (const name of ["departments", "folders", "folder_user_access", "files", "file_versions", "audit_log"])
        await client.query(`create temp table ${name} (like filesvc.${name} including all) on commit drop`);
    await client.query(
        "create temp table audit_security_events (action text,outcome text,request_id uuid,route text,status integer) on commit drop",
    );
    const definition = (
        await client.query("select pg_get_functiondef('filesvc.folder_visible(uuid,uuid,uuid,uuid,uuid)'::regprocedure) as definition")
    ).rows[0].definition;
    await client.query(definition.replaceAll("filesvc.", "pg_temp."));
    for (const id of [dept, otherDept])
        await wrapped.query("insert into filesvc.departments(id,tenant_id,application_id,code,name) values ($1,$2,$3,$4,$4)", [
            id,
            tenant,
            application,
            id,
        ]);
    for (const [id, parentId, visibility] of [
        [parent, null, "restricted"],
        [child, parent, "department"],
        [publicFolder, null, "department"],
    ])
        await wrapped.query(
            "insert into filesvc.folders(id,tenant_id,application_id,department_id,name,parent_folder_id,visibility) values ($1,$2,$3,$4,$5,$6,$7)",
            [id, tenant, application, dept, id, parentId, visibility],
        );
    const matches = [];
    for (let i = 0; i < 6; i++) matches.push(await insertFile());
    const otherOwner = await insertFile({ owner: "owner-B" });
    const secret = await insertFile({ folder: child }),
        inPublic = await insertFile({ folder: publicFolder });
    await insertFile({ departmentId: otherDept });
    await insertFile({ tenantId: randomUUID() });
    await insertFile({ applicationId: randomUUID() });
    await insertFile({ status: "deleted" });
    await insertFile({ status: "pending_upload" });
    await insertFile({ status: "quarantined" });
    const displayOnly = await insertFile({ name: "notes.txt", display: "งบประมาณปีหน้า", tags: ["2569"], type: "text/plain" });
    const special = await insertFile({ name: "O'Reilly_100%\\report.txt", tags: [], type: "text/plain" });
    const expected = [...matches, otherOwner, inPublic, displayOnly].sort().reverse();
    assert.deepEqual(ids(await search({ q: " งบ\n  2569\t " })), expected);
    assert.deepEqual(ids(await search({ q: "finance งบ" })), [...matches, otherOwner, inPublic].sort().reverse());
    assert.deepEqual(ids(await search({ q: "FiNaNcE" })), [...matches, otherOwner, inPublic].sort().reverse());
    assert.deepEqual(ids(await search({ q: "งบ 2570" })), []);
    assert.equal((await search({ q: "งบ งบ 2569" })).items.length, 9);
    assert.deepEqual(ids(await search({ q: "O'Reilly_100%\\report" })), [special]);
    for (const term of ["%", "_", "\\"]) assert.deepEqual(ids(await search({ q: term })), [special]);
    assert.deepEqual(ids(await search({ q: "' OR 1=1 --" })), []);
    const legacy = await search({ limit: 2 });
    assert.ok(legacy.nextCursor);
    assert.equal(JSON.parse(Buffer.from(legacy.nextCursor, "base64url")).searchFingerprint, undefined);
    assert.ok((await search({ limit: 2, cursor: legacy.nextCursor })).items.length);
    const all = ids(await search());
    for (const q of [null, "", " \t\n "]) assert.deepEqual(ids(await search({ q })), all);
    for (const q of [2, {}, [], true, "ก".repeat(201), Array(11).fill("งบ").join(" ")]) await error({ q }, "invalid_search_query");
    let cursor = null,
        pages = [];
    do {
        const page = await search({ q: "งบ 2569", limit: 2, cursor });
        pages.push(...ids(page));
        cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(pages, expected);
    assert.equal(new Set(pages).size, pages.length);
    const first = await search({ q: "งบ 2569", limit: 2 });
    const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url"));
    assert.match(decoded.searchFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(decoded).includes("งบ"), false);
    await search({ q: "  งบ\t2569 ", limit: 2, cursor: first.nextCursor });
    for (const change of [
        { q: "Finance" },
        { q: null },
        { tag: "Finance" },
        { departmentId: dept },
        { contentType: "text/plain" },
        { createdFrom: "2026-11-03" },
        { folderId: publicFolder },
    ])
        await error({ q: "งบ 2569", limit: 2, cursor: first.nextCursor, ...change }, "invalid_cursor");
    await error({ q: "งบ 2569", cursor: legacy.nextCursor }, "invalid_cursor");
    assert.deepEqual(
        ids(
            await search({
                q: "งบ 2569",
                tag: "Finance",
                contentType: "APPLICATION/PDF",
                createdFrom: "2026-11-03",
                createdTo: "2026-11-03",
            }),
        ),
        [...matches, otherOwner, inPublic].sort().reverse(),
    );
    assert.deepEqual(ids(await search({ q: "งบ 2569", tag: "finance" })), [], "Exact tag filter is unchanged");
    assert.deepEqual(ids(await search({ q: "งบ", folderId: publicFolder })), [inPublic]);
    assert.deepEqual(ids(await search({ q: "งบ", folderId: parent })), [], "Folder searches do not recurse");
    await wrapped.query(
        "insert into filesvc.folder_user_access(tenant_id,application_id,department_id,folder_id,user_id) values ($1,$2,$3,$4,$5)",
        [tenant, application, dept, parent, user],
    );
    assert.ok(ids(await search({ q: "งบ" })).includes(secret), "Restricted ancestor allowlist is honored");
    await wrapped.query("delete from filesvc.folder_user_access");
    assert.equal(ids(await search({ q: "งบ" })).includes(secret), false);
    app = { ...identity, userId: randomUUID() };
    await error({ q: "งบ 2569", cursor: first.nextCursor }, "invalid_cursor");
    app = { ...identity, departments: [{ id: otherDept, role: "viewer" }] };
    assert.equal((await search({ q: "งบ" })).items.length, 1);
    app = { ...identity, tenantId: randomUUID() };
    assert.equal((await search({ q: "งบ" })).items.length, 0);
    app = { ...identity, applicationId: randomUUID() };
    assert.equal((await search({ q: "งบ" })).items.length, 0);
    app = { ...identity, userId: undefined, keyId: randomUUID() };
    assert.ok(ids(await search({ q: "งบ", ownerSubject: "owner-A" })).includes(secret), "Trusted keys retain existing folder policy");
    const keyPage = await search({ q: "งบ", ownerSubject: "owner-A", limit: 2 });
    app = { ...app, keyId: randomUUID() };
    await error({ q: "งบ", ownerSubject: "owner-A", limit: 2, cursor: keyPage.nextCursor }, "invalid_cursor");
    assert.equal(ids(await search({ q: "งบ", ownerSubject: "owner-A" })).includes(otherOwner), false);
    assert.deepEqual(ids(await search({ q: "งบ", ownerSubject: "owner-B" })), [otherOwner]);
    assert.equal((await call({ q: "งบ" })).status, 400, "Keys still require ownerSubject");
    app = { ...identity, scopes: [] };
    assert.equal((await call({ q: "งบ" })).status, 403);
    app = null;
    assert.equal((await call({ q: "งบ" })).status, 401);
    app = { ...identity, departments: [{ id: dept, role: "editor" }] };
    const updated = await PATCH(
        new Request(`http://fixture/api/v1/files/${displayOnly}/metadata`, {
            method: "PATCH",
            body: JSON.stringify({ displayName: "แผนยุทธศาสตร์ใหม่", tags: ["เอกสารใหม่"] }),
        }),
        { params: Promise.resolve({ fileId: displayOnly }) },
    );
    assert.equal(updated.status, 200);
    assert.equal(ids(await search({ q: "งบ 2569" })).includes(displayOnly), false);
    assert.deepEqual(ids(await search({ q: "ยุทธศาสตร์ ใหม่" })), [displayOnly]);
    // Version publication/restore updates these cached current-name fields in
    // its own transaction. Historical version names are never part of search.
    const historical = randomUUID();
    await wrapped.query(
        `insert into filesvc.file_versions(id,file_id,version_number,bucket_id,object_key,original_name,content_type,size_bytes,status,created_by_kind)
      values ($1,$2,1,'private-files',$3,'HISTORICAL_ONLY.pdf','application/pdf',12,'available','migration')`,
        [historical, displayOnly, `${tenant}/${application}/${displayOnly}/versions/${historical}`],
    );
    assert.deepEqual(ids(await search({ q: "HISTORICAL_ONLY" })), []);
    await wrapped.query("update filesvc.files set original_name='CURRENT_REVISION.pdf',current_version_id=$2 where id=$1", [
        displayOnly,
        historical,
    ]);
    assert.deepEqual(ids(await search({ q: "CURRENT_REVISION" })), [displayOnly]);
    // Scoped synthetic baseline; existing listing indexes only, no new index.
    await wrapped.query(
        `insert into filesvc.files(tenant_id,application_id,department_id,owner_subject,bucket_id,object_key,original_name,display_name,content_type,size_bytes,status,tags)
      select $1,$2,$3,'load-fixture','private-files',gen_random_uuid()::text,'synthetic-'||i||'.pdf',case when i%10=0 then 'รายงานงบการเงิน '||i else 'เอกสารทั่วไป '||i end,
      'application/pdf',12,'available',array['2569'] from generate_series(1,5000) i`,
        [tenant, application, dept],
    );
    await client.query("analyze pg_temp.files");
    await search({ q: "งบ 2569", departmentId: dept, limit: 25 });
    const plan = (await client.query(`explain (analyze,buffers,format json) ${lastListQuery.sql}`, lastListQuery.values)).rows[0][
        "QUERY PLAN"
    ][0];
    console.log(
        `Synthetic EXPLAIN: 5000 additional rows; execution=${plan["Execution Time"]}ms, planning=${plan["Planning Time"]}ms, root=${plan.Plan["Node Type"]}.`,
    );
    console.log(
        "File search checks passed: Thai/English AND terms, literal patterns/injection, metadata/current names, legacy compatibility, scoped cursors, filters, pagination, permissions/ancestors, key owner, lifecycle and synthetic EXPLAIN.",
    );
} finally {
    await client.query("rollback");
    client.release();
    await pool.end();
}
