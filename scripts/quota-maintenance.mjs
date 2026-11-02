import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createClient} from '@supabase/supabase-js';
import {acquireStorageMaintenance,maintenancePaths} from '../src/infrastructure/storage/storage-maintenance.mjs';
import {readQuotaSnapshot,inspectQuota,applyQuotaDepartment,storageInspector,departmentFingerprint} from './quota-reconciliation.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const mode=process.argv[2],args=process.argv.slice(3),options={};
if(args.includes('--help')) {
    console.log('quota:backfill / quota:reconcile [--tenant-id UUID] [--application-id UUID] [--department-id UUID] [--apply]');
    console.log('Defaults to report only. With no scope, requires exactly one active application. --apply pauses local API/worker mutations and drains active work.');
}else await main();

async function main() {
    let pool,releaseMaintenance;
    const runId=randomUUID(),report={runId,mode,startedAt:new Date().toISOString(),apply:false,results:[]};
    let reportPath;
    const save=()=>{if(reportPath)writeFileSync(reportPath,JSON.stringify(report,null,2),{mode:0o600});};
    try {
        if(!['backfill','reconcile'].includes(mode))throw new Error('invalid_mode');
        for(let index=0;index<args.length;index++) {
            const flag=args[index];
            if(flag==='--apply'){options.apply=true;continue;}
            if(!['--tenant-id','--application-id','--department-id'].includes(flag)||!UUID.test(args[index+1]??''))throw new Error('invalid_arguments');
            if(options[flag])throw new Error('duplicate_argument');
            options[flag]=args[++index];
        }
        if(!process.env.DATABASE_URL||!process.env.SUPABASE_URL||!process.env.SUPABASE_SECRET_KEY||!process.env.STORAGE_BUCKET)throw new Error('missing_configuration');
        pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,connectionTimeoutMillis:5000,statement_timeout:30000});
        const identity=(await pool.query('select current_user')).rows[0].current_user;
        if(identity==='postgres'||identity.startsWith('postgres.'))throw new Error('dedicated_database_login_required');
        const apps=(await pool.query(`select id,tenant_id from filesvc.applications where status='active'
          and ($1::uuid is null or tenant_id=$1) and ($2::uuid is null or id=$2) order by id`,[options['--tenant-id']??null,options['--application-id']??null])).rows;
        if(apps.length!==1)throw new Error('specify_one_application');
        const scope={tenantId:apps[0].tenant_id,applicationId:apps[0].id};
        const storage=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{
            auth:{persistSession:false,autoRefreshToken:false},
            global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.any([AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])])})},
        });
        const inspector=storageInspector(storage,process.env.STORAGE_BUCKET);
        report.apply=Boolean(options.apply);report.scope=scope;
        const root=maintenancePaths().root;mkdirSync(root,{recursive:true});
        reportPath=path.join(root,`${mode}-${runId}.json`);save();
        if(options.apply){console.log('Pausing local storage mutations; waiting for active work to drain...');releaseMaintenance=await acquireStorageMaintenance();}
        const snapshot=await readQuotaSnapshot(pool,scope);
        if(options['--department-id']&&!snapshot.departments.some(d=>d.id===options['--department-id']))throw new Error('department_not_found');
        const plan=await inspectQuota(snapshot,scope,inspector,{mode,departmentId:options['--department-id']});
        report.inspection=plan;save();
        for(const department of plan.departments) {
            let outcome=department.canApply?'verified':'blocked';
            if(options.apply&&department.canApply) {
                try {
                    // Recheck Storage outside the DB transaction. Ignore revisions
                    // of other departments already committed in this same run.
                    const freshSnapshot=await readQuotaSnapshot(pool,scope);
                    if(departmentFingerprint(freshSnapshot,department.departmentId)!==department.fingerprint)throw new Error('quota_snapshot_changed');
                    const fresh=await inspectQuota(freshSnapshot,scope,inspector,{mode,departmentId:department.departmentId});
                    const candidate=fresh.departments[0];
                    if(!candidate?.canApply||fresh.inventoryFingerprint!==plan.inventoryFingerprint
                        ||JSON.stringify(candidate.proposals)!==JSON.stringify(department.proposals))throw new Error('storage_snapshot_changed');
                    outcome=await applyQuotaDepartment(pool,scope,snapshot,department,{mode,runId});
                }catch(error){outcome='failed';department.applyError=safeError(error);}
            }
            report.results.push({departmentId:department.departmentId,outcome,usedBytes:department.usedBytes,reservedBytes:department.reservedBytes,
                counterDrift:department.counterDrift,issueCount:department.issues.length});save();
            console.log(`${department.departmentId}: ${outcome}; used=${department.usedBytes}, reserved=${department.reservedBytes}; issues=${department.issues.length}`);
        }
        report.finishedAt=new Date().toISOString();save();
        if(plan.globalIssues.length||report.results.some(r=>['blocked','failed'].includes(r.outcome)))process.exitCode=2;
        console.log(`Report: ${reportPath}`);
    }catch(error){report.error=safeError(error);save();console.error('Quota maintenance failed:',report.error);process.exitCode=1;}
    finally{try{releaseMaintenance?.();}finally{await pool?.end();}}
}
function safeError(error) {
    const known=['invalid_mode','invalid_arguments','duplicate_argument','missing_configuration','dedicated_database_login_required','specify_one_application',
        'department_not_found','quota_snapshot_changed','storage_snapshot_changed','maintenance_drain_timeout','maintenance_owner_changed','invalid_mutation_lease'];
    return known.includes(error?.message)?error.message:typeof error?.code==='string'&&/^[a-z0-9_]{1,60}$/i.test(error.code)?error.code:'quota_maintenance_failed';
}
