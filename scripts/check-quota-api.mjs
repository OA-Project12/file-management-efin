// API routes and real SQL on TEMP fixtures; all changes roll back.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import {Pool} from 'pg';

const require=createRequire(import.meta.url),cache=new Map(),pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:5000});
const client=await pool.connect(),stack=[];let seq=0,failAudit=false,queries=0;
const wrapped={async query(sql,values){
    if(sql==='begin'){const s=`api_${++seq}`;stack.push(s);return client.query(`savepoint ${s}`);}
    if(sql==='commit')return client.query(`release savepoint ${stack.pop()}`);
    if(sql==='rollback'){const s=stack.pop();await client.query(`rollback to savepoint ${s}`);return client.query(`release savepoint ${s}`);}
    if(failAudit&&sql.includes('insert into filesvc.audit_log'))throw new Error('Injected audit failure');
    queries++;return client.query(sql.replaceAll('filesvc.','pg_temp.'),values);
},release(){}};
const testPool={connect:async()=>wrapped,query:(...args)=>wrapped.query(...args)};
const tenant=randomUUID(),application=randomUUID(),department=randomUUID(),second=randomUUID(),pending=randomUUID();
const admin={tenantId:tenant,applicationId:application,userId:randomUUID(),isTenantAdmin:true,keyId:'',scopes:['files:read','files:write','departments:manage'],departments:[]};
let app=admin;
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
    const compiled={exports:{}};cache.set(file,compiled);
    const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','module','exports',code)(name=>{
        if(name==='server-only')return {};
        if(name==='./pool'||name==='@/infrastructure/database/pool')return {getDatabasePool:()=>testPool};
        if(name==='@/infrastructure/auth/application-key-authenticator')return {authenticateApplicationKey:async()=>app};
        if(name.startsWith('@/'))return load(path.join('src',name.endsWith('.mjs')?name.slice(2):`${name.slice(2)}.ts`));
        if(name.startsWith('.'))return load(path.resolve(path.dirname(file),`${name}.ts`));
        return require(name);
    },compiled,compiled.exports);return compiled.exports;
}
const {GET}=load('src/app/api/v1/departments/storage-quotas/route.ts');
const {PATCH}=load('src/app/api/v1/departments/[departmentId]/storage-quota/route.ts');
const {parseQuotaAmount,exactQuotaAmount,formatQuotaBytes,quotaCapacityStatus}=load('src/domain/storage/quota-presentation.ts');
const read=()=>GET(new Request('http://fixture/api/v1/departments/storage-quotas'));
const write=(body,id=department)=>PATCH(new Request(`http://fixture/api/v1/departments/${id}/storage-quota`,{method:'PATCH',body:JSON.stringify(body)}),{params:Promise.resolve({departmentId:id})});
const row=async(id=department)=>(await wrapped.query('select limit_bytes::text,used_bytes::text,reserved_bytes::text,revision::text from filesvc.department_storage_quotas where department_id=$1',[id])).rows[0];
async function expectError(response,status,code){assert.equal(response.status,status);assert.equal(response.headers.get('Cache-Control'),'no-store');const json=await response.json();assert.equal(json.error.code,code);return json.error;}
for(const unit of ['bytes','MB','GB'])assert.equal(parseQuotaAmount(exactQuotaAmount('9007199254740993',unit),unit),'9007199254740993');
assert.equal(parseQuotaAmount('0.000000001','GB'),'1');assert.equal(parseQuotaAmount('0.000001','MB'),'1');
assert.throws(()=>parseQuotaAmount('1.0000000001','GB'));assert.throws(()=>parseQuotaAmount('1.1','bytes'));assert.throws(()=>parseQuotaAmount('9223372036854775808','bytes'));
assert.equal(formatQuotaBytes(null),'—');assert.equal(formatQuotaBytes('0'),'0 bytes');
assert.equal(formatQuotaBytes('18446744073709551614'),'18.45 EB');
for(const [committed,limit,kind] of [['79','100','normal'],['80','100','warning'],['100','100','full'],['101','100','over'],['0','0','full']])
    assert.equal(quotaCapacityStatus({accountingStatus:'ready',limitBytes:limit,committedBytes:committed}).kind,kind);
try {
    await client.query('begin');
    for(const name of ['departments','department_storage_quotas','audit_log'])await client.query(`create temp table ${name} (like filesvc.${name} including all) on commit drop`);
    await client.query('create temp table audit_security_events (action text,outcome text,request_id uuid,route text,status integer) on commit drop');
    for(const id of [department,second,pending]){
        await wrapped.query('insert into filesvc.departments(id,tenant_id,application_id,code,name) values ($1,$2,$3,$4,$4)',[id,tenant,application,id]);
        await wrapped.query('insert into filesvc.department_storage_quotas(tenant_id,application_id,department_id,used_bytes,reserved_bytes,initialized_at) values ($1,$2,$3,$4,$5,$6)',[tenant,application,id,id===department?'70':'0',id===department?'20':'0',id===pending?null:new Date()]);
    }
    queries=0;let response=await read();assert.equal(response.status,200);let result=await response.json();
    assert.equal(result.data.items.length,3);assert.ok(result.data.items.every(i=>i.canManageQuota));assert.equal(queries,1,'Listing uses one query');
    assert.equal(result.data.items.find(i=>i.departmentId===pending).usedBytes,null);
    const grant=role=>[{id:department,role}];
    for(const role of ['editor','admin','viewer']){
        app={...admin,userId:randomUUID(),isTenantAdmin:false,departments:grant(role)};
        result=await (await read()).json();assert.equal(result.data.items.length,role==='viewer'?0:1);assert.ok(result.data.items.every(i=>!i.canManageQuota));
        await expectError(await write({limitBytes:'100',expectedRevision:'0'}),403,'department_quota_forbidden');
    }
    app={...admin,userId:undefined,isTenantAdmin:true,keyId:randomUUID(),scopes:['files:read','files:write','keys:manage'],departments:grant('admin')};
    assert.equal((await (await read()).json()).data.items.length,1);await expectError(await write({limitBytes:'100',expectedRevision:'0'}),403,'department_quota_forbidden');
    app={...app,scopes:['files:write']};await expectError(await read(),403,'department_quota_forbidden');
    app=null;await expectError(await read(),401,'unauthorized');await expectError(await write({}),401,'unauthorized');
    for(const override of [{tenantId:randomUUID()},{applicationId:randomUUID()}]){
        app={...admin,...override};assert.equal((await (await read()).json()).data.items.length,0);
        await expectError(await write({limitBytes:'100',expectedRevision:'0'}),404,'department_quota_not_found');
    }
    app=admin;
    for(const body of [{},[],null,{limitBytes:100,expectedRevision:'0'},{limitBytes:'100',expectedRevision:0},{limitBytes:'100',expectedRevision:'0',tenantId:tenant}])
        assert.equal((await write(body)).status,400);
    for(const value of ['-1','01','1.2','1e3','9223372036854775808'])await expectError(await write({limitBytes:value,expectedRevision:'0'}),400,'invalid_quota_bytes');
    await expectError(await write({limitBytes:null,expectedRevision:'01'}),400,'invalid_quota_bytes');
    await expectError(await write({limitBytes:null,expectedRevision:'0'},'invalid'),400,'invalid_department_id');
    const badJson=new Request('http://fixture',{method:'PATCH',body:'{'});await expectError(await PATCH(badJson,{params:Promise.resolve({departmentId:department})}),400,'invalid_json');
    const below=await expectError(await write({limitBytes:'89',expectedRevision:'0'}),409,'quota_limit_below_committed');assert.equal(below.details.minimumLimitBytes,'90');
    response=await write({limitBytes:'90',expectedRevision:'0'});assert.equal(response.status,200);assert.equal((await response.json()).data.availableBytes,'0');
    assert.equal((await row()).revision,'1');
    const count=async()=>(await wrapped.query("select count(*) from filesvc.audit_log where action='department.quota_update' and outcome='success'")).rows[0].count;
    assert.equal(await count(),'1');assert.equal((await write({limitBytes:'90',expectedRevision:'1'})).status,200);assert.equal(await count(),'1');
    await expectError(await write({limitBytes:'90',expectedRevision:'0'}),409,'quota_revision_conflict');
    failAudit=true;await expectError(await write({limitBytes:'100',expectedRevision:'1'}),503,'service_unavailable');failAudit=false;
    assert.equal((await row()).limit_bytes,'90');assert.equal((await row()).revision,'1');
    // Every producer of accounting updates revision under this same row lock:
    // upload admission, transfers and worker releases invalidate an open form.
    for(const mutation of ["reserved_bytes=reserved_bytes+1","used_bytes=used_bytes+1","used_bytes=used_bytes-1"]){
        const revision=(await row()).revision;
        await wrapped.query(`update filesvc.department_storage_quotas set ${mutation},revision=revision+1 where department_id=$1`,[department]);
        await expectError(await write({limitBytes:'100',expectedRevision:revision}),409,'quota_revision_conflict');
    }
    assert.equal((await write({limitBytes:null,expectedRevision:(await row()).revision})).status,200);
    assert.equal((await write({limitBytes:'0',expectedRevision:'0'},second)).status,200);
    await expectError(await write({limitBytes:'100',expectedRevision:'0'},pending),503,'quota_accounting_not_ready');
    assert.equal((await write({limitBytes:null,expectedRevision:'0'},pending)).status,200);
    const huge='9007199254740993';assert.equal((await write({limitBytes:huge,expectedRevision:'1'},second)).status,200);assert.equal((await row(second)).limit_bytes,huge);
    const oldFlag=process.env.STORAGE_QUOTA_MAINTENANCE;process.env.STORAGE_QUOTA_MAINTENANCE='1';
    try{assert.equal((await read()).status,200);await expectError(await write({limitBytes:null,expectedRevision:'0'}),503,'storage_maintenance');}
    finally{if(oldFlag===undefined)delete process.env.STORAGE_QUOTA_MAINTENANCE;else process.env.STORAGE_QUOTA_MAINTENANCE=oldFlag;}
    const details=(await wrapped.query("select details from filesvc.audit_log where action='department.quota_update' and outcome='success' order by occurred_at limit 1")).rows[0].details;
    assert.equal(details.usedBytes,'70');assert.equal(details.reservedBytes,'20');assert.equal(details.beforeLimitBytes,null);assert.equal(details.afterLimitBytes,'90');
    console.log('Quota API checks passed: role/scopes, tenant/application isolation, one-query listing, validation/BigInt, min committed bytes, zero/unlimited, readiness, revision/no-op, audit rollback and maintenance.');
}finally{await client.query('rollback');client.release();await pool.end();}

if(process.argv.includes('--live-read')) {
    const live=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000});
    try {
        const {PostgresDepartmentQuotaRepository}=load('src/infrastructure/database/postgres-department-quota-repository.ts');
        const context=(await live.query("select id,tenant_id from filesvc.applications where status='active' order by id limit 1")).rows[0];
        const items=await new PostgresDepartmentQuotaRepository(live).list({tenantId:context.tenant_id,applicationId:context.id},[],true);
        assert.ok(items.length);for(const item of items){assert.equal(typeof item.usedBytes,'string');assert.ok(item.limitBytes===null||typeof item.limitBytes==='string');}
        console.log(`Live read passed: ${items.length} departments loaded; live limits were not modified.`);
        // Read-only row-lock test: the setter must wait for the same quota lock
        // as upload/move/worker accounting. The requested value is the current
        // limit (a no-op), and both outer transactions always roll back.
        const selected=items.find(item=>item.initializedAt),a=await live.connect(),b=await live.connect();let waiting;
        try {
            assert.ok(selected);await a.query('begin');await b.query('begin');
            const locked=(await a.query(`select limit_bytes::text as limit,revision::text from filesvc.department_storage_quotas
              where tenant_id=$1 and application_id=$2 and department_id=$3 for update`,[context.tenant_id,context.id,selected.departmentId])).rows[0];
            const pid=(await b.query('select pg_backend_pid() as pid')).rows[0].pid;
            const transactionPool={connect:async()=>({release(){},async query(sql,values){
                if(sql==='begin')return b.query('savepoint setter');
                if(sql==='commit')return b.query('release savepoint setter');
                if(sql==='rollback'){await b.query('rollback to savepoint setter');return b.query('release savepoint setter');}
                return b.query(sql,values);
            }})};
            waiting=new PostgresDepartmentQuotaRepository(transactionPool).setLimit({...admin,tenantId:context.tenant_id,applicationId:context.id},selected.departmentId,locked.limit,locked.revision);
            let blocked=false;
            for(let i=0;i<50&&!blocked;i++) {
                blocked=(await a.query("select wait_event_type='Lock' as blocked from pg_stat_activity where pid=$1",[pid])).rows[0]?.blocked===true;
                if(!blocked)await new Promise(resolve=>setTimeout(resolve,20));
            }
            assert.equal(blocked,true);await a.query('rollback');const result=await waiting;
            assert.equal(result.limitBytes,locked.limit);assert.equal(result.revision,locked.revision);
            console.log('Quota setter cross-connection lock check passed; no limit changes and all transactions rolled back.');
        }finally{await a.query('rollback');await waiting?.catch(()=>undefined);await b.query('rollback');a.release();b.release();}
    }finally{await live.end();}
}
