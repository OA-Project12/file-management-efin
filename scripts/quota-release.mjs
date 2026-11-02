import {randomUUID} from "node:crypto";

// Caller holds the parent file lock and has confirmed removal via Storage API.
// The receipt contains only objects whose deletion (or absence) was verified.
export async function releaseDeletedStorage(client,scope,objects,{all=false,evidence={}}={}) {
    const verified=new Set(objects.map(o=>JSON.stringify([o.bucket_id,o.object_key])));
    const entries=(await client.query(`select id,department_id,bucket_id,object_key,charged_bytes::text,reserved_bytes::text
      from filesvc.storage_allocations where tenant_id=$1 and application_id=$2 and file_id=$3 and state<>'released'`,
    [scope.tenantId,scope.applicationId,scope.fileId])).rows;
    if(all && entries.some(e=>!verified.has(JSON.stringify([e.bucket_id,e.object_key]))))
        throw Object.assign(new Error("Purge contains an unverified allocation"),{code:"quota_objects_not_verified"});
    const releasing=entries.filter(e=>verified.has(JSON.stringify([e.bucket_id,e.object_key])));
    if(!releasing.length) return 0;
    const ids=[...new Set(releasing.map(e=>e.department_id))];
    const quotas=(await client.query(`select department_id,used_bytes::text,reserved_bytes::text
      from filesvc.department_storage_quotas where tenant_id=$1 and application_id=$2 and department_id=any($3::uuid[])
      order by department_id for update`,[scope.tenantId,scope.applicationId,ids])).rows;
    if(quotas.length!==ids.length) throw Object.assign(new Error("Quota row is missing"),{code:"quota_accounting_inconsistent"});
    for(const quota of quotas) {
        const group=releasing.filter(e=>e.department_id===quota.department_id);
        const used=group.reduce((sum,e)=>sum+BigInt(e.charged_bytes),BigInt(0));
        const reserved=group.reduce((sum,e)=>sum+BigInt(e.reserved_bytes),BigInt(0));
        if(BigInt(quota.used_bytes)<used || BigInt(quota.reserved_bytes)<reserved)
            throw Object.assign(new Error("Quota counters do not cover the allocation"),{code:"quota_accounting_inconsistent"});
        await client.query(`update filesvc.department_storage_quotas set used_bytes=used_bytes-$4::bigint,
          reserved_bytes=reserved_bytes-$5::bigint,revision=revision+1,updated_at=now()
          where tenant_id=$1 and application_id=$2 and department_id=$3`,
        [scope.tenantId,scope.applicationId,quota.department_id,used.toString(),reserved.toString()]);
        await client.query(`update filesvc.storage_allocations set state='released',charged_bytes=0,reserved_bytes=0,
          released_at=now(),updated_at=now() where id=any($1::uuid[]) and state<>'released'`,[group.map(e=>e.id)]);
        await client.query(`insert into filesvc.audit_log
          (tenant_id,application_id,actor_kind,action,outcome,resource_type,resource_id,request_id,details)
          values ($1,$2,'worker','storage.quota_released','success','file',$3,$4,$5::jsonb)`,
        [scope.tenantId,scope.applicationId,scope.fileId,randomUUID(),JSON.stringify({departmentId:quota.department_id,
            usedBytes:used.toString(),reservedBytes:reserved.toString(),allocationCount:group.length,...evidence})]);
    }
    return releasing.length;
}
