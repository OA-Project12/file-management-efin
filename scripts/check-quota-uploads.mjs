// Real SQL on isolated TEMP tables; all fixtures rolled back. Storage/Auth are simulated.
// Also verifies the quota row lock between two connections, with no committed writes.
// node --env-file=.env.local scripts/check-quota-uploads.mjs
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {Pool} from "pg";
import ts from "typescript";
const require=createRequire(import.meta.url),modules=new Map();
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:5000});
const client=await pool.connect();
let serial=0,failAudit=false;
const stack=[];
const wrapped={async query(sql,values){
    if(sql==="begin"){const s=`quota_${++serial}`;stack.push(s);return client.query(`savepoint ${s}`);}
    if(sql==="commit")return client.query(`release savepoint ${stack.pop()}`);
    if(sql==="rollback"){const s=stack.pop();await client.query(`rollback to savepoint ${s}`);return client.query(`release savepoint ${s}`);}
    if(failAudit&&sql.includes("insert into filesvc.audit_log"))throw new Error("Injected audit failure");
    return client.query(sql.replaceAll("filesvc.","pg_temp.").replaceAll("pg_temp.folder_visible(","filesvc.folder_visible("),values);
},release(){}};
const testPool={connect:async()=>wrapped,query:(...args)=>wrapped.query(...args)};
const tenant=randomUUID(),application=randomUUID(),dept=randomUUID();
const app={tenantId:tenant,applicationId:application,keyId:randomUUID(),scopes:["files:read","files:write"],departments:[{id:dept,role:"editor"}]};
function load(file){
    file=path.resolve(file);if(modules.has(file))return modules.get(file).exports;
    const compiled={exports:{}};modules.set(file,compiled);
    const code=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function("require","module","exports",code)(name=>{
        if(name==="server-only")return {};
        if(name==="./pool"||name==="@/infrastructure/database/pool")return {getDatabasePool:()=>testPool};
        if(name==="@/infrastructure/auth/application-key-authenticator")return {authenticateApplicationKey:async()=>app};
        if(name==="@/infrastructure/storage/supabase-object-storage")return {SupabaseObjectStorage:class{async createUploadGrant(key){return {bucket:"private-files",objectKey:key,token:"fixture",signedUrl:"https://example.invalid"};}}};
        if(name.startsWith("@/"))return load(path.join("src",name.endsWith('.mjs')?name.slice(2):`${name.slice(2)}.ts`));
        if(name.startsWith("."))return load(path.resolve(path.dirname(file),`${name}.ts`));
        return require(name);
    },compiled,compiled.exports);return compiled.exports;
}
const {PostgresUploadIntentRepository}=load("src/infrastructure/database/postgres-upload-intent-repository.ts");
const {PostgresFileVersionRepository}=load("src/infrastructure/database/postgres-file-version-repository.ts");
const original=new PostgresUploadIntentRepository(testPool),versions=new PostgresFileVersionRepository();
const scope={app,ownerSubject:"quota-fixture"};
async function create(bytes){const id=randomUUID();await original.createPendingUpload({auditActor:app,fileId:id,tenantId:tenant,
    applicationId:application,departmentId:dept,ownerSubject:scope.ownerSubject,bucketId:"private-files",objectKey:`${tenant}/${application}/${id}`,
    originalName:"fixture.txt",contentType:"text/plain",sizeBytes:bytes,checksumSha256:null,tokenFingerprint:Buffer.alloc(32),expiresInSeconds:7200});return id;}
async function quota(){return (await wrapped.query("select used_bytes::text,reserved_bytes::text from filesvc.department_storage_quotas where department_id=$1",[dept])).rows[0];}
async function consistent(){const q=await quota();const totals=(await wrapped.query("select coalesce(sum(charged_bytes),0)::text as used,coalesce(sum(reserved_bytes),0)::text as reserved from filesvc.storage_allocations where department_id=$1",[dept])).rows[0];assert.equal(q.used_bytes,totals.used);assert.equal(q.reserved_bytes,totals.reserved);}
try {
    await client.query("begin");
    for(const name of ["files","file_versions","upload_intents","version_upload_intents","version_restore_intents","department_storage_quotas","storage_allocations","audit_log"])
        await client.query(`create temp table ${name} (like filesvc.${name} including all) on commit drop`);
    await wrapped.query("insert into filesvc.department_storage_quotas (tenant_id,application_id,department_id,limit_bytes,initialized_at) values ($1,$2,$3,100,now())",[tenant,application,dept]);
    const file=await create(60);
    assert.deepEqual(await quota(),{used_bytes:"0",reserved_bytes:"60"});
    await assert.rejects(create(41),{code:"department_quota_exceeded"});
    assert.equal((await wrapped.query("select count(*) from filesvc.files")).rows[0].count,"1","Failed admission rolls back the entire file/intent");
    assert.equal(await original.completeUpload(app,file,tenant,application,[dept],50,"text/plain"),true);
    assert.deepEqual(await quota(),{used_bytes:"50",reserved_bytes:"0"});
    assert.equal(await original.completeUpload(app,file,tenant,application,[dept],50,"text/plain"),false);
    const head=(await versions.list(file,scope,25,null)).currentVersionId;
    const makeVersion=async(bytes)=>{const id=randomUUID();await versions.create(file,scope,{versionId:id,expectedCurrentVersionId:head,bucketId:"private-files",
        objectKey:`${tenant}/${application}/${file}/versions/${id}`,originalName:"revision.txt",contentType:"text/plain",sizeBytes:bytes,checksumSha256:null});return id;};
    const v2=await makeVersion(40);
    assert.deepEqual(await quota(),{used_bytes:"50",reserved_bytes:"40"});
    await assert.rejects(makeVersion(11),{code:"department_quota_exceeded"});
    assert.equal(await versions.complete(file,v2,scope,40,"text/plain",false),null);
    await versions.complete(file,v2,scope,40,"text/plain",false);
    assert.deepEqual(await quota(),{used_bytes:"90",reserved_bytes:"0"});
    const restoreId=randomUUID();
    await assert.rejects(versions.reserveRestore(file,head,scope,{versionId:restoreId,expectedCurrentVersionId:v2,
        objectKey:`${tenant}/${application}/${file}/versions/${restoreId}`,sizeBytes:50,contentType:"text/plain"}),{code:"department_quota_exceeded"});
    await wrapped.query("update filesvc.department_storage_quotas set limit_bytes=500 where department_id=$1",[dept]);
    await versions.reserveRestore(file,head,scope,{versionId:restoreId,expectedCurrentVersionId:v2,
        objectKey:`${tenant}/${application}/${file}/versions/${restoreId}`,sizeBytes:50,contentType:"text/plain"});
    await versions.completeRestore(file,restoreId,scope);await versions.completeRestore(file,restoreId,scope);
    assert.deepEqual(await quota(),{used_bytes:"140",reserved_bytes:"0"});
    const broken=randomUUID();
    await versions.reserveRestore(file,head,scope,{versionId:broken,expectedCurrentVersionId:restoreId,
        objectKey:`${tenant}/${application}/${file}/versions/${broken}`,sizeBytes:50,contentType:"text/plain"});
    await versions.failRestore(file,broken,scope,"copy_failed");
    assert.deepEqual(await quota(),{used_bytes:"140",reserved_bytes:"50"},"Failed copy keeps reservation until worker cleanup");
    const mismatch=await create(10);
    assert.equal(await original.completeUpload(app,mismatch,tenant,application,[dept],15,"text/plain"),"upload_size_exceeds_reservation");
    assert.equal((await original.findUpload(mismatch,tenant,application)).status,"quarantined");
    assert.deepEqual(await quota(),{used_bytes:"155",reserved_bytes:"50"},"Observed overage is charged, not silently released");
    const mismatchVersion=randomUUID();
    await versions.create(file,scope,{versionId:mismatchVersion,expectedCurrentVersionId:restoreId,bucketId:"private-files",
        objectKey:`${tenant}/${application}/${file}/versions/${mismatchVersion}`,originalName:"bigger.txt",contentType:"text/plain",sizeBytes:10,checksumSha256:null});
    assert.equal(await versions.complete(file,mismatchVersion,scope,12,"text/plain",false),"upload_size_exceeds_reservation");
    assert.equal((await versions.find(file,mismatchVersion,scope)).status,"quarantined");
    assert.equal((await versions.list(file,scope,25,null)).currentVersionId,restoreId);
    const before=await quota();failAudit=true;
    await assert.rejects(create(5),/Injected audit failure/);failAudit=false;
    assert.deepEqual(await quota(),before);
    const rollbackFile=await create(5);failAudit=true;
    await assert.rejects(original.completeUpload(app,rollbackFile,tenant,application,[dept],5,"text/plain"),/Injected audit failure/);failAudit=false;
    assert.equal((await original.findUpload(rollbackFile,tenant,application)).status,"pending_upload");
    await consistent();
    const {POST}=load("src/app/api/v1/files/upload-intents/batch/route.ts");
    const q=await quota();const total=BigInt(q.used_bytes)+BigInt(q.reserved_bytes)+BigInt(6);
    await wrapped.query("update filesvc.department_storage_quotas set limit_bytes=$2::bigint where department_id=$1",[dept,total.toString()]);
    const response=await POST(new Request("http://example.test/api/v1/files/upload-intents/batch",{method:"POST",body:JSON.stringify({ownerSubject:scope.ownerSubject,departmentId:dept,
        files:[{originalName:"one.txt",contentType:"text/plain",sizeBytes:4},{originalName:"two.txt",contentType:"text/plain",sizeBytes:4}]})}));
    assert.equal(response.status,200);
    const data=(await response.json()).data;assert.equal(data.readyCount,1);assert.equal(data.errorCount,1);assert.equal(data.items[1].error.code,"department_quota_exceeded");
    await consistent();
    await wrapped.query("update filesvc.department_storage_quotas set limit_bytes=null,initialized_at=null where department_id=$1",[dept]);
    await create(1000);await consistent();
    const legacy=await create(3);
    await wrapped.query("delete from filesvc.storage_allocations where file_id=$1",[legacy]);
    await wrapped.query("update filesvc.department_storage_quotas set reserved_bytes=reserved_bytes-3 where department_id=$1",[dept]);
    assert.equal(await original.completeUpload(app,legacy,tenant,application,[dept],2,"text/plain"),true,"Uninitialized accounting adopts legacy pending intents");
    await consistent();
    await wrapped.query("update filesvc.department_storage_quotas set limit_bytes=500 where department_id=$1",[dept]);
    await assert.rejects(create(1),{code:"quota_accounting_not_ready"});
    console.log("Quota upload checks passed: admission, completion, version/restore, partial batch, idempotency, overage quarantine, retained failed reservations and audit rollback.");
} finally {await client.query("rollback");client.release();}

// Real cross-connection lock check. Both connections always roll back every write.
const a=await pool.connect(),b=await pool.connect();let waiting;
try {
    const file=(await a.query(`select id,tenant_id,application_id,department_id,bucket_id from filesvc.files
      where status='deleted' and trashed_at is null limit 1`)).rows[0];
    if(!file) throw new Error("A permanently deleted file context is required for the rollback-only lock check");
    const pid=(await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    await a.query("begin");await b.query("begin");
    await a.query("select department_id from filesvc.department_storage_quotas where tenant_id=$1 and application_id=$2 and department_id=$3 for update",[file.tenant_id,file.application_id,file.department_id]);
    await b.query("select id from filesvc.files where id=$1 for update",[file.id]);
    const {reserveStorage}=load("src/infrastructure/database/storage-quota-accounting.ts");
    waiting=reserveStorage(b,{...app,tenantId:file.tenant_id,applicationId:file.application_id},{fileId:file.id,bucketId:file.bucket_id,
        objectKey:`${file.tenant_id}/${file.application_id}/${file.id}/versions/${randomUUID()}`,kind:"initial_upload",expectedBytes:1,expiresAt:new Date(Date.now()+7200_000)});
    let blocked=false;
    for(let i=0;i<50&&!blocked;i++) {
        blocked=(await a.query("select wait_event_type='Lock' as blocked from pg_stat_activity where pid=$1",[pid])).rows[0]?.blocked===true;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(blocked,true,"Reservation must wait for the locked quota row");
    await a.query("rollback");await waiting;
    console.log("Cross-connection quota serialization passed; all writes rolled back.");
} finally {await a.query("rollback");await waiting?.catch(()=>undefined);await b.query("rollback");a.release();b.release();await pool.end();}
