import {randomUUID} from "node:crypto";
import {releaseDeletedStorage} from "./quota-release.mjs";

export async function purgeFileObjects(pool,file,removeObject) {
    const state=(await pool.query(`select f.status,f.trashed_at,f.bucket_id,f.object_key,greatest(
      (select max(expires_at) from filesvc.upload_intents where file_id=f.id),
      (select max(expires_at) from filesvc.version_upload_intents where file_id=f.id),
      (select max(expires_at) from filesvc.version_restore_intents where file_id=f.id and completed_at is null)
    ) as last_expiry from filesvc.files f where f.id=$1 and f.tenant_id=$2 and f.application_id=$3`,
    [file.fileId,file.tenantId,file.applicationId])).rows[0];
    if(!state || !(state.status==="deleting" || (state.status==="deleted" && state.trashed_at===null))) throw new Error("File is not pending purge");
    if(state.last_expiry && new Date(state.last_expiry).getTime()+60_000>Date.now()) throw new Error("Waiting for upload/restore expiry before purge");
    const objects=(await pool.query(`select v.bucket_id,v.object_key from filesvc.file_versions v
      join filesvc.files f on f.id=v.file_id where f.id=$1 and f.tenant_id=$2 and f.application_id=$3
      union select a.bucket_id,a.object_key from filesvc.storage_allocations a
      where a.file_id=$1 and a.tenant_id=$2 and a.application_id=$3 and a.state<>'released'`,
    [file.fileId,file.tenantId,file.applicationId])).rows;
    objects.push({bucket_id:state.bucket_id,object_key:state.object_key});
    const unique=[...new Map(objects.map(o=>[JSON.stringify([o.bucket_id,o.object_key]),o])).values()];
    const prefix=`${file.tenantId}/${file.applicationId}/${file.fileId}`;
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for(const object of unique) {
        const suffix=object.object_key.startsWith(`${prefix}/versions/`)?object.object_key.slice(`${prefix}/versions/`.length):"";
        if((object.object_key!==prefix && !uuid.test(suffix)) || !/^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(object.bucket_id))
            throw new Error("Unexpected purge object key");
    }
    for(const object of unique) await removeObject(object.bucket_id,object.object_key);
    return unique;
}

export async function finishFilePurge(pool,event,file,verifiedObjects) {
    const client=await pool.connect();
    try {
        await client.query("begin");
        const parent=(await client.query(`select id,status,trashed_at from filesvc.files
          where id=$1 and tenant_id=$2 and application_id=$3 for update`,[file.fileId,file.tenantId,file.applicationId])).rows[0];
        if(!parent || !(parent.status==="deleting" || (parent.status==="deleted" && parent.trashed_at===null)))
            throw new Error("File is not pending purge");
        const claimed=await client.query(`select id from filesvc.outbox where id=$1 and aggregate_id=$2
          and event_type='file.object_delete_requested' and processed_at is null for update`,[event.id,file.fileId]);
        if(!claimed.rowCount) {await client.query("commit");return false;}
        await releaseDeletedStorage(client,{tenantId:file.tenantId,applicationId:file.applicationId,fileId:file.fileId},verifiedObjects,
            {all:true,evidence:{outboxId:event.id}});
        await client.query(`update filesvc.files set status='deleted',trashed_at=null,updated_at=now() where id=$1`,[file.fileId]);
        await client.query(`update filesvc.outbox set processed_at=now() where id=$1`,[event.id]);
        await client.query(`insert into filesvc.audit_log
          (tenant_id,application_id,actor_kind,action,outcome,resource_type,resource_id,request_id,details)
          values ($1,$2,'worker','file.object_deleted','success','file',$3,$4,$5::jsonb)`,
        [file.tenantId,file.applicationId,file.fileId,randomUUID(),JSON.stringify({outboxId:event.id})]);
        await client.query("commit");return true;
    } catch(error) {await client.query("rollback").catch(()=>undefined);throw error;}
    finally {client.release();}
}
