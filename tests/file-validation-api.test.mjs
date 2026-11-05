import { jpeg, fixturePdf } from './fixtures/file-bytes.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import pg from 'pg';
import {createLoader} from './helpers/load-typescript.mjs';
import {scheduleObjectCleanup, processObjectCleanup} from '../scripts/object-cleanup.mjs';
import {claimScan, finishScan, cleanupInfectedSource} from '../scripts/malware-scan-jobs.mjs';
import {processScan} from '../scripts/process-malware-scans.mjs';
process.env.MALWARE_SCAN_MODE='required';
const url=new URL(process.env.DATABASE_URL??'');
assert.ok(['127.0.0.1','localhost','postgres'].includes(url.hostname)&&url.pathname==='/efin_security','Disposable fixture DB required');
const pool=new pg.Pool({connectionString:url.toString(),max:5});
const workerPool=new pg.Pool({connectionString:url.toString(),options:'-c role=filesvc_worker',max:2});
const apiPool=new pg.Pool({connectionString:url.toString(),options:'-c role=filesvc_api',max:1});
after(()=>Promise.all([pool.end(),workerPool.end(),apiPool.end()]));
const tenant=randomUUID(),appId=randomUUID(),dept=randomUUID(),keyId=randomUUID(),user=randomUUID();
const actor={tenantId:tenant,applicationId:appId,keyId,scopes:['files:read','files:write'],departments:[{id:dept,code:'test',name:'Test',role:'editor'}]};
await pool.query('insert into filesvc.tenants(id,name) values($1,$2)',[tenant,'Validation fixture']);
await pool.query('insert into filesvc.applications(id,tenant_id,name) values($1,$2,$3)',[appId,tenant,'Validation fixture']);
await pool.query('insert into filesvc.departments(id,tenant_id,application_id,code,name) values($1,$2,$3,$4,$5)',[dept,tenant,appId,'validation','Validation']);
await pool.query('insert into filesvc.department_storage_quotas(tenant_id,application_id,department_id,initialized_at) values($1,$2,$3,now())',[tenant,appId,dept]);
await pool.query("insert into filesvc.application_keys(id,tenant_id,application_id,scopes) values($1,$2,$3,$4)",[keyId,tenant,appId,actor.scopes]);
await pool.query("insert into filesvc.application_key_departments(application_key_id,department_id,role) values($1,$2,'editor')",[keyId,dept]);
const pdf=fixturePdf(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64');
const objects=new Map(),failAudits=new Set();let grants=0,reads=0,deleted=0,corruptCopy=false,unavailable=false;
class Storage {
 async createUploadGrant(key){grants++;return{bucket:'private-files',objectKey:key,signedUrl:'https://fixture.invalid/upload',token:'fixture-only'};}
 async getObjectInfo(_b,key){if(unavailable)throw Error('fixture upstream');const o=objects.get(key);return o?{sizeBytes:o.bytes.length,contentType:o.type,eTag:o.tag??'stable'}:null;}
 async readObjectPrefix(_b,key){reads++;if(unavailable)throw Error('fixture upstream');return objects.get(key).bytes.subarray(0,1024);}
 async copyObject(_b,source,dest){const o=objects.get(source);objects.set(dest,{...o,bytes:corruptCopy?Buffer.alloc(o.bytes.length):Buffer.from(o.bytes)});}
 async deleteObject(_b,key){deleted++;objects.delete(key);}
 async createDownloadGrant(){return{signedUrl:'https://fixture.invalid/read',expiresInSeconds:300};}
 async createPreviewGrant(){return{signedUrl:'https://fixture.invalid/read',expiresInSeconds:300};}
}
const overrides={
 '@/infrastructure/database/pool':{getDatabasePool:()=>pool},
 '@/infrastructure/storage/supabase-object-storage':{SupabaseObjectStorage:Storage},
 '@/infrastructure/audit/audit-route':{auditRoute:(_a,_r,handler)=>handler},
 'next/server':{connection:async()=>{}},
 '@/infrastructure/auth/application-key-authenticator':{authenticateApplicationKey:async req=>{
   const mode=req.headers.get('authorization')??'key';
   if(mode==='none')return null;
   if(mode==='viewer')return{...actor,departments:[{...actor.departments[0],role:'viewer'}]};
   if(mode==='other-tenant')return{...actor,tenantId:randomUUID()};
   if(mode==='other-app')return{...actor,applicationId:randomUUID()};
   if(mode==='auth')return{...actor,userId:user};
   return actor;
 }},
};
const baseLoader=createLoader(overrides),realAudit=baseLoader('src/infrastructure/audit/record-audit.ts');
overrides['@/infrastructure/audit/record-audit']={...realAudit,recordAudit:async(a,event,client)=>{if(failAudits.has(event.resourceId)&&['file.scan_queued','file.quarantined','file.upload_complete','file.version_upload_complete','file.version_quarantined','file.version_restore','file.restore'].includes(event.action))throw Error('fixture audit failure');return realAudit.recordAudit(a,event,client);}};
const load=createLoader(overrides);
const single=load('src/app/api/v1/files/upload-intents/route.ts').POST;
const batch=load('src/app/api/v1/files/upload-intents/batch/route.ts').POST;
const complete=load('src/app/api/v1/files/[fileId]/complete/route.ts').POST;
const restoreTrash=load('src/app/api/v1/files/[fileId]/restore/route.ts').POST;
const scanStatus=load('src/app/api/v1/files/[fileId]/scan-jobs/[scanId]/route.ts').GET;
const versions=load('src/infrastructure/http/file-version-handlers.ts');
const request=(body={},mode='key')=>new Request('http://fixture/api/v1/test',{method:'POST',headers:{authorization:mode,'Content-Type':'application/json'},body:JSON.stringify(body)});
const ctx=(fileId,versionId)=>({params:Promise.resolve({fileId,versionId})});
const scalar=async(sql,args)=>(await pool.query(sql,args)).rows[0];
async function intent(name='a.pdf',type='application/pdf',size=pdf.length,mode='key'){
 const r=await single(request({ownerSubject:'fixture-owner',departmentId:dept,originalName:name,contentType:type,sizeBytes:size},mode));assert.equal(r.status,201,await r.clone().text());return(await r.json()).data;
}
const storage = new Storage();
const workerStorage = {
 info:(...args)=>storage.getObjectInfo(...args),
 async open(_bucket,key) { return [objects.get(key).bytes]; },
 copy:(...args)=>storage.copyObject(...args),
 remove:(...args)=>storage.deleteObject(...args),
};
const fixtureScanner = (verdict="clean") => async (open, expectedBytes, signal) => {
 const hash=createHash("sha256");let size=0;
 for await(const part of await open(signal)){hash.update(part);size+=part.length;}
 assert.equal(size,expectedBytes);
 return {verdict,sha256:hash.digest("hex")};
};
async function submitAndScan(response, verdict="clean", status="available") {
 assert.equal(response.status,202,await response.clone().text());
 const receipt=(await response.json()).data;
 assert.equal(receipt.status,"pending_scan");
 const job=await claimScan(workerPool);assert.equal(job?.id,receipt.scanId);
 assert.equal(await processScan(workerPool,job,workerStorage,fixtureScanner(verdict),new AbortController().signal),status);
 return receipt;
}
async function available(){
 const i=await intent();objects.set(i.objectKey,{bytes:pdf,type:'application/pdf'});
 await submitAndScan(await complete(request(),ctx(i.fileId)));
 const row=await scalar('select current_version_id from filesvc.files where id=$1',[i.fileId]);return{...i,current:row.current_version_id};
}
async function versionIntent(file,bytes=pdf,name='next.pdf',type='application/pdf'){
 const r=await versions.createVersionUpload(request({ownerSubject:'fixture-owner',expectedCurrentVersionId:file.current,originalName:name,contentType:type,sizeBytes:bytes.length}),ctx(file.fileId));assert.equal(r.status,201,await r.clone().text());const data=(await r.json()).data;objects.set(data.objectKey,{bytes,type});return data;
}

test('single/batch/version intent policy refuses unsupported types before grants; mixed batch isolates errors',async()=>{
 const before=grants;
 const bad=await single(request({ownerSubject:'fixture-owner',departmentId:dept,originalName:'a.exe',contentType:'application/pdf',sizeBytes:10}));assert.equal(bad.status,415);assert.equal(grants,before);
 const r=await batch(request({ownerSubject:'fixture-owner',departmentId:dept,files:[{originalName:'ok.PDF',contentType:'APPLICATION/PDF',sizeBytes:pdf.length},{originalName:'bad.txt',contentType:'text/plain',sizeBytes:10}]}));assert.equal(r.status,200);
 const items=(await r.json()).data.items;assert.equal(items[0].status,'ready');assert.equal(items[1].error.code,'file_type_not_allowed');assert.equal(grants,before+1);
 const f=await available(),g=grants;
 const rejected=await versions.createVersionUpload(request({ownerSubject:'fixture-owner',expectedCurrentVersionId:f.current,originalName:'no.exe',contentType:'application/pdf',sizeBytes:10}),ctx(f.fileId));assert.equal(rejected.status,415);assert.equal(grants,g);
});
test('complete mismatch quarantines atomically, retains quota and leaves object for expiry-safe worker cleanup',async()=>{
 const i=await intent('a.pdf','application/pdf',png.length);objects.set(i.objectKey,{bytes:png,type:'application/pdf'});
 const r=await complete(request(),ctx(i.fileId));assert.equal(r.status,415);assert.equal((await r.json()).error.code,'file_type_mismatch');
 const file=await scalar('select status,current_version_id from filesvc.files where id=$1',[i.fileId]);assert.equal(file.status,'quarantined');assert.equal(file.current_version_id,null);
 const ledger=await scalar('select state,charged_bytes from filesvc.storage_allocations where file_id=$1',[i.fileId]);assert.equal(ledger.state,'release_pending');assert.equal(ledger.charged_bytes,String(png.length));assert.ok(objects.has(i.objectKey));assert.equal(deleted,0);
 const audit=await scalar("select details from filesvc.audit_log where resource_id=$1 and action='file.quarantined'",[i.fileId]);assert.equal(audit.details.reason,'file_type_mismatch');assert.equal(audit.details.detectedMime,'image/png');assert.equal(audit.details.validationPolicy,'signature-v1');
});
test('successful complete is idempotent/concurrent and Audit failure rolls back publish, quarantine and quota',async()=>{
 const i=await intent();objects.set(i.objectKey,{bytes:pdf,type:'application/pdf'});failAudits.add(i.fileId);
 let r=await complete(request(),ctx(i.fileId));assert.equal(r.status,503);
 assert.equal((await scalar('select status from filesvc.files where id=$1',[i.fileId])).status,'pending_upload');assert.equal((await scalar('select state from filesvc.storage_allocations where file_id=$1',[i.fileId])).state,'reserved');
 objects.set(i.objectKey,{bytes:Buffer.alloc(pdf.length),type:'application/pdf'});r=await complete(request(),ctx(i.fileId));assert.equal(r.status,503);assert.equal((await scalar('select status from filesvc.files where id=$1',[i.fileId])).status,'pending_upload');
 failAudits.delete(i.fileId);objects.set(i.objectKey,{bytes:pdf,type:'application/pdf'});
 const responses=await Promise.all([complete(request(),ctx(i.fileId)),complete(request(),ctx(i.fileId))]);assert.ok(responses.every(x=>x.status===202));
 const receipts=await Promise.all(responses.map(x=>x.json()));
 assert.equal(receipts[0].data.scanId,receipts[1].data.scanId);
 await submitAndScan(Response.json(receipts[0],{status:202}));
 assert.equal((await complete(request(),ctx(i.fileId))).status,200);
 assert.equal((await scalar("select count(*) as n from filesvc.audit_log where resource_id=$1 and action='file.scan_published'",[i.fileId])).n,'1');
 assert.equal((await scalar('select count(*) as n from filesvc.file_versions where file_id=$1',[i.fileId])).n,'1');
});
test('read outage leaves pending and can be completed later; rejected version preserves current version',async()=>{
 const i=await intent();objects.set(i.objectKey,{bytes:pdf,type:'application/pdf'});unavailable=true;
 const r=await complete(request(),ctx(i.fileId));unavailable=false;assert.equal(r.status,503);assert.equal((await r.json()).error.code,'file_validation_unavailable');assert.equal((await scalar('select status from filesvc.files where id=$1',[i.fileId])).status,'pending_upload');
 await submitAndScan(await complete(request(),ctx(i.fileId)));
 const f=await available(),v=await versionIntent(f,Buffer.alloc(pdf.length));
 const bad=await versions.completeVersionUpload(request({ownerSubject:'fixture-owner'}),ctx(f.fileId,v.versionId));assert.equal(bad.status,415);
 assert.equal((await scalar('select current_version_id from filesvc.files where id=$1',[f.fileId])).current_version_id,f.current);
 assert.equal((await scalar('select status from filesvc.file_versions where id=$1',[v.versionId])).status,'quarantined');assert.ok(objects.has(v.objectKey));
});
test('version restore validates source and copy, keeps current on copy rejection, and succeeds with audit',async()=>{
 const f=await available(),v=await versionIntent(f);await submitAndScan(await versions.completeVersionUpload(request({ownerSubject:'fixture-owner'}),ctx(f.fileId,v.versionId)));
 const body={ownerSubject:'fixture-owner',expectedCurrentVersionId:v.versionId};corruptCopy=true;
 await submitAndScan(await versions.restoreVersion(request(body),ctx(f.fileId,f.current)),'clean','scan_failed');corruptCopy=false;
 assert.equal((await scalar('select current_version_id from filesvc.files where id=$1',[f.fileId])).current_version_id,v.versionId);
 const data=await submitAndScan(await versions.restoreVersion(request(body),ctx(f.fileId,f.current)));
 assert.equal((await scalar('select restored_from_version_id from filesvc.file_versions where id=$1',[data.versionId])).restored_from_version_id,f.current);assert.notEqual(data.versionId,f.current);
 // An old unsupported source remains readable metadata, but cannot be restored.
 await pool.query("update filesvc.file_versions set original_name='legacy.txt',content_type='text/plain' where id=$1",[v.versionId]);
 const denied=await versions.restoreVersion(request({ownerSubject:'fixture-owner',expectedCurrentVersionId:data.versionId}),ctx(f.fileId,v.versionId));assert.equal(denied.status,415);
});
test('trash restore checks bytes; old reads remain available; viewer/cross-scope/owner/folder denial precedes content read',async()=>{
 const f=await available();await pool.query("update filesvc.files set status='deleted',trashed_at=now() where id=$1",[f.fileId]);
 objects.set(f.objectKey,{bytes:Buffer.alloc(pdf.length),type:'application/pdf'});
 assert.equal((await restoreTrash(request({ownerSubject:'fixture-owner'}),ctx(f.fileId))).status,415);assert.equal((await scalar('select status from filesvc.files where id=$1',[f.fileId])).status,'deleted');
 objects.set(f.objectKey,{bytes:pdf,type:'application/pdf'});await submitAndScan(await restoreTrash(request({ownerSubject:'fixture-owner'}),ctx(f.fileId)));
 const before=reads;
 for(const mode of ['viewer','other-tenant','other-app','none']){const r=await complete(request({},mode),ctx((await intent()).fileId));assert.ok([401,403,404].includes(r.status));}
 const r=await versions.completeVersionUpload(request({ownerSubject:'wrong-owner'}),ctx(f.fileId,f.current));assert.equal(r.status,404);
 const folder=randomUUID();await pool.query("insert into filesvc.folders(id,tenant_id,application_id,department_id,name,visibility) values($1,$2,$3,$4,'Restricted','restricted')",[folder,tenant,appId,dept]);
 const i=await intent();await pool.query('update filesvc.files set folder_id=$2 where id=$1',[i.fileId,folder]);assert.equal((await complete(request({},'auth'),ctx(i.fileId))).status,404);assert.equal(reads,before);
});

test('legacy non-allowlisted files still download; completing an already published file skips validation',async()=>{
 const f=await available();await pool.query("update filesvc.files set original_name='legacy.txt',content_type='text/plain' where id=$1",[f.fileId]);
 const before=reads;
 const download=load('src/app/api/v1/files/[fileId]/download-url/route.ts').POST;
 const r=await download(request({ownerSubject:'fixture-owner'}),ctx(f.fileId));assert.equal(r.status,200,await r.clone().text());
 assert.equal((await complete(request(),ctx(f.fileId))).status,200);assert.equal(reads,before);
});

test('valid PNG and JPEG can complete; version audit failure rolls back the head and reservation',async()=>{
 for(const [name,type,bytes] of [['pixel.PNG','IMAGE/PNG',png],['photo.jpeg','image/jpeg',jpeg]]){
  const i=await intent(name,type,bytes.length);objects.set(i.objectKey,{bytes,type});await submitAndScan(await complete(request(),ctx(i.fileId)));
 }
 const f=await available(),v=await versionIntent(f);failAudits.add(f.fileId);
 assert.equal((await versions.completeVersionUpload(request({ownerSubject:'fixture-owner'}),ctx(f.fileId,v.versionId))).status,503);
 failAudits.delete(f.fileId);
 assert.equal((await scalar('select current_version_id from filesvc.files where id=$1',[f.fileId])).current_version_id,f.current);
 assert.equal((await scalar('select status from filesvc.file_versions where id=$1',[v.versionId])).status,'pending_upload');
 assert.equal((await scalar('select state from filesvc.storage_allocations where version_id=$1',[v.versionId])).state,'reserved');
});

test('quarantine cleanup waits for grant expiry/grace and only releases bytes after confirmed removal',async()=>{
 const i=await intent();objects.set(i.objectKey,{bytes:Buffer.alloc(pdf.length),type:'application/pdf'});
 assert.equal((await complete(request(),ctx(i.fileId))).status,415);
 await scheduleObjectCleanup(pool,100);
 assert.equal((await scalar('select count(*) as n from filesvc.object_cleanup_jobs where file_id=$1',[i.fileId])).n,'0');
 await pool.query("update filesvc.upload_intents set expires_at=now()-interval '2 hours' where file_id=$1",[i.fileId]);
 await scheduleObjectCleanup(pool,100);
 let job=await scalar("update filesvc.object_cleanup_jobs set lease_token=$2,attempts=attempts+1 where file_id=$1 returning *",[i.fileId,randomUUID()]);
 assert.ok(job);
 const quiet={log(){},error(){}};
 assert.equal(await processObjectCleanup(pool,job,async()=>{throw Error('fixture deletion failed');},quiet),'retry');
 assert.equal((await scalar('select state from filesvc.storage_allocations where file_id=$1',[i.fileId])).state,'release_pending');assert.ok(objects.has(i.objectKey));
 job=await scalar('update filesvc.object_cleanup_jobs set lease_token=$2 where file_id=$1 returning *',[i.fileId,randomUUID()]);
 assert.equal(await processObjectCleanup(pool,job,async(_bucket,key)=>{objects.delete(key);assert.ok(!objects.has(key));},quiet),'completed');
 const allocation=await scalar('select state,charged_bytes,reserved_bytes from filesvc.storage_allocations where file_id=$1',[i.fileId]);assert.equal(allocation.state,'released');assert.equal(allocation.charged_bytes,'0');assert.equal(allocation.reserved_bytes,'0');
});

test('pending and infected uploads issue no URL; scan polling is owner and tenant scoped',async()=>{
 const file=await intent();objects.set(file.objectKey,{bytes:pdf,type:'application/pdf'});
 const response=await complete(request(),ctx(file.fileId));assert.equal(response.status,202);
 const {data:receipt}=await response.clone().json();
 const download=load('src/app/api/v1/files/[fileId]/download-url/route.ts').POST;
 const preview=load('src/app/api/v1/files/[fileId]/preview-url/route.ts').POST;
 const ctxScan={params:Promise.resolve({fileId:file.fileId,scanId:receipt.scanId})};
 const poll=(owner,identity="key")=>scanStatus(new Request("http://fixture"+receipt.statusUrl+"?ownerSubject="+owner,{headers:{authorization:identity}}),ctxScan);
 for(const route of [download,preview]) assert.equal((await route(request({ownerSubject:'fixture-owner'}),ctx(file.fileId))).status,404);
 assert.equal((await poll('wrong-owner')).status,404);
 assert.equal((await poll('fixture-owner','other-tenant')).status,404);
 assert.equal((await poll('fixture-owner','other-app')).status,404);
 assert.equal((await poll('fixture-owner','viewer')).status,404);
 const pending=await poll('fixture-owner');assert.equal(pending.headers.get("cache-control"),"no-store");assert.equal((await pending.json()).data.status,"pending_scan");
 await submitAndScan(response,'infected','quarantined');
 for(const route of [download,preview]) assert.equal((await route(request({ownerSubject:'fixture-owner'}),ctx(file.fileId))).status,404);
 assert.equal((await (await poll('fixture-owner')).json()).data.code,'malware_detected');
 assert.equal((await scalar("select state from filesvc.storage_allocations where file_id=$1",[file.fileId])).state,"release_pending");
});

test('expired leases are reclaimed, old results are rejected and revoked keys cannot publish',async()=>{
 const file=await intent();objects.set(file.objectKey,{bytes:pdf,type:'application/pdf'});
 assert.equal((await complete(request(),ctx(file.fileId))).status,202);
 const first=await claimScan(pool);
 await pool.query("update filesvc.malware_scan_jobs set lease_until=now()-interval '1 second' where id=$1",[first.id]);
 const second=await claimScan(pool);assert.equal(second.id,first.id);assert.notEqual(second.lease_id,first.lease_id);
 assert.equal(await finishScan(pool,first,{verdict:'clean',sha256:'0'.repeat(64)}),'lost');
 await pool.query("update filesvc.application_keys set revoked_at=now() where id=$1",[keyId]);
 try{
  assert.equal(await processScan(pool,second,workerStorage,fixtureScanner(),new AbortController().signal),'scan_failed');
 }finally{await pool.query("update filesvc.application_keys set revoked_at=null where id=$1",[keyId]);}
 const result=await scalar('select result_code from filesvc.malware_scan_jobs where id=$1',[first.id]);
 assert.equal(result.result_code,'scan_permission_changed');
 assert.equal((await scalar('select status from filesvc.files where id=$1',[file.fileId])).status,'failed');
});

test('temporary scan errors retry, expiry is terminal and an unscannable legacy object stays in trash',async()=>{
 const f=await available();
 await pool.query("update filesvc.files set status='deleted',trashed_at=now() where id=$1",[f.fileId]);
 const response=await restoreTrash(request({ownerSubject:'fixture-owner'}),ctx(f.fileId));assert.equal(response.status,202);
 const first=await claimScan(pool);
 assert.equal(await processScan(pool,first,workerStorage,async()=>{throw Error('scanner unavailable');},new AbortController().signal),'pending_scan');
 assert.equal(await claimScan(pool),undefined);
 await pool.query("update filesvc.malware_scan_jobs set expires_at=now()-interval '1 second' where id=$1",[first.id]);
 const expired=await claimScan(pool);
 assert.equal(await processScan(pool,expired,workerStorage,fixtureScanner(),new AbortController().signal),'scan_failed');
 await submitAndScan(await restoreTrash(request({ownerSubject:'fixture-owner'}),ctx(f.fileId)),'unscannable','scan_failed');
 assert.ok(objects.has(f.objectKey));
 assert.equal((await scalar('select status from filesvc.files where id=$1',[f.fileId])).status,'deleted');
});

test('infected legacy version blocks historical grants and cleanup releases only the verified source',async()=>{
 const f=await available(),v=await versionIntent(f);
 await submitAndScan(await versions.completeVersionUpload(request({ownerSubject:'fixture-owner'}),ctx(f.fileId,v.versionId)));
 const restore=await versions.restoreVersion(request({ownerSubject:'fixture-owner',expectedCurrentVersionId:v.versionId}),ctx(f.fileId,f.current));
 const receipt=await submitAndScan(restore,'infected','quarantined');
 const old=await versions.previewVersion(request({ownerSubject:'fixture-owner'}),ctx(f.fileId,f.current));assert.equal(old.status,404);
 const current=await versions.previewVersion(request({ownerSubject:'fixture-owner'}),ctx(f.fileId,v.versionId));assert.equal(current.status,200);
 assert.ok(objects.has(f.objectKey));
 assert.equal(await cleanupInfectedSource(pool,workerStorage),false);
 await pool.query("update filesvc.malware_scan_jobs set cleanup_after=now() where id=$1",[receipt.scanId]);
 assert.equal(await cleanupInfectedSource(pool,workerStorage),true);
 assert.ok(!objects.has(f.objectKey));assert.ok(objects.has(v.objectKey));
 assert.equal((await scalar('select state from filesvc.storage_allocations where file_id=$1 and object_key=$2',[f.fileId,f.objectKey])).state,'released');
});

test('API cannot publish a verdict; worker publication and Audit commit together under its DB role', async () => {
 const uploaded = await intent();
 objects.set(uploaded.objectKey, { bytes: pdf, type: 'application/pdf' });
 const response = await complete(request(), ctx(uploaded.fileId));
 assert.equal(response.status, 202);
 const { data: receipt } = await response.json();
 await assert.rejects(apiPool.query("update filesvc.malware_scan_jobs set status='available' where id=$1", [receipt.scanId]), { code: '42501' });
 const job = await claimScan(workerPool);
 assert.equal(job.id, receipt.scanId);

 const client = await pool.connect();
 try {
   await client.query("alter table filesvc.audit_log add constraint fixture_block_scan_publish check (action <> 'file.scan_published') not valid");
   await assert.rejects(
     processScan(workerPool, job, workerStorage, fixtureScanner(), new AbortController().signal),
     { code: '23514' },
   );
   assert.equal((await scalar('select status from filesvc.files where id=$1', [uploaded.fileId])).status, 'pending_scan');
   assert.equal((await scalar('select status from filesvc.malware_scan_jobs where id=$1', [job.id])).status, 'scanning');
 } finally {
   await client.query('alter table filesvc.audit_log drop constraint if exists fixture_block_scan_publish');
   client.release();
 }
 assert.equal(await processScan(workerPool, job, workerStorage, fixtureScanner(), new AbortController().signal), 'available');
});

test('restore retries an uncertain copy at the same key; changed objects never publish', async () => {
 const file = await available();
 const next = await versionIntent(file);
 await submitAndScan(await versions.completeVersionUpload(request({ownerSubject:'fixture-owner'}), ctx(file.fileId,next.versionId)));
 const result = await versions.restoreVersion(
   request({ownerSubject:'fixture-owner',expectedCurrentVersionId:next.versionId}), ctx(file.fileId,file.current),
 );
 assert.equal(result.status, 202);
 const {data: receipt} = await result.json();
 let copies = 0;
 const unstableStorage = {
   ...workerStorage,
   async copy(...args) {
     copies++;
     await workerStorage.copy(...args);
     throw Object.assign(new Error('lost copy acknowledgment'), {code:'copy_unavailable'});
   },
 };
 const job = await claimScan(pool);
 assert.equal(job.id, receipt.scanId);
 assert.equal(await processScan(pool,job,unstableStorage,fixtureScanner(),new AbortController().signal), 'pending_scan');
 assert.equal((await scalar('select current_version_id from filesvc.files where id=$1',[file.fileId])).current_version_id,next.versionId);
 await pool.query('update filesvc.malware_scan_jobs set next_attempt_at=now() where id=$1', [job.id]);
 const retry = await claimScan(pool);
 assert.equal(retry.id, job.id);
 assert.equal(await processScan(pool,retry,unstableStorage,fixtureScanner(),new AbortController().signal), 'available');
 assert.equal(copies,1);

 const uploaded = await intent();
 objects.set(uploaded.objectKey, { bytes: pdf, type: 'application/pdf' });
 const completeResponse = await complete(request(), ctx(uploaded.fileId));
 assert.equal(completeResponse.status, 202);
 const changed = await claimScan(pool);
 const scanner = async (...args) => {
   const scanned = await fixtureScanner()(...args);
   objects.get(uploaded.objectKey).tag = 'changed-during-scan';
   return scanned;
 };
 assert.equal(await processScan(pool,changed,workerStorage,scanner,new AbortController().signal), 'scan_failed');
 assert.equal((await scalar('select result_code from filesvc.malware_scan_jobs where id=$1', [changed.id])).result_code, 'object_changed');
});
