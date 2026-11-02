import { randomUUID } from "node:crypto";
import { releaseDeletedStorage } from "./quota-release.mjs";

export const CLEANUP_GRACE_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = "('pending_upload','failed','quarantined')";

// Only tracked, incomplete operations qualify. Available versions (including trash)
// and all references to a current object are protected independently of job payloads.
const TARGETS = `with targets as (
  select f.id as file_id,f.tenant_id,f.application_id,null::uuid as version_id,
         'initial_upload'::text as kind,f.bucket_id,f.object_key,ui.expires_at
  from filesvc.files f join filesvc.upload_intents ui on ui.file_id=f.id
  where f.status in ${TERMINAL} and ui.completed_at is null
  union all
  select f.id,f.tenant_id,f.application_id,v.id,
         case when r.version_id is not null then 'version_restore' else 'version_upload' end,
         v.bucket_id,v.object_key,greatest(u.expires_at,r.expires_at)
  from filesvc.file_versions v join filesvc.files f on f.id=v.file_id
  left join filesvc.version_upload_intents u on u.version_id=v.id
  left join filesvc.version_restore_intents r on r.version_id=v.id
  where v.status in ${TERMINAL} and (u.version_id is not null or r.version_id is not null)
    and u.completed_at is null and r.completed_at is null
), inspected as (
  select t.*,t.expires_at+($1::int * interval '1 second') as ready_at,
    exists(select 1 from filesvc.file_versions v
      left join filesvc.files f on f.current_version_id=v.id
      where v.bucket_id=t.bucket_id and v.object_key=t.object_key
        and (v.status='available' or f.id is not null))
    or exists(select 1 from filesvc.files f where f.bucket_id=t.bucket_id and f.object_key=t.object_key
      and (f.status in ('available','deleting') or f.trashed_at is not null)) as protected
  from targets t
) select *,ready_at <= now() as expired from inspected`;

function valid(target) {
    const ids = [target.file_id, target.tenant_id, target.application_id];
    if (target.version_id) ids.push(target.version_id);
    if (!ids.every((id) => typeof id === "string" && UUID.test(id))) return false;
    const prefix = `${target.tenant_id}/${target.application_id}/${target.file_id}`;
    const expected = target.version_id ? `${prefix}/versions/${target.version_id}` : prefix;
    return (
        target.object_key === expected &&
        typeof target.bucket_id === "string" &&
        /^[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]$/.test(target.bucket_id)
    );
}

async function transaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
    } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

async function audit(client, job, action, outcome, details = {}) {
    await client.query(
        `insert into filesvc.audit_log
         (tenant_id,application_id,actor_kind,action,outcome,resource_type,resource_id,request_id,details)
         values ($1,$2,'worker',$3,$4,'file',$5,$6,$7::jsonb)`,
        [
            job.tenant_id,
            job.application_id,
            action,
            outcome,
            job.file_id,
            randomUUID(),
            JSON.stringify({ jobId: job.id, versionId: job.version_id, kind: job.kind, ...details }),
        ],
    );
}

async function targetFor(client, fileId, versionId) {
    return (
        await client.query(
            `select * from (${TARGETS}) t
      where file_id=$2 and version_id is not distinct from $3::uuid`,
            [CLEANUP_GRACE_SECONDS, fileId, versionId],
        )
    ).rows[0];
}

export async function scheduleObjectCleanup(pool, limit = 10) {
    const candidates = await pool.query(
        `select * from (${TARGETS}) t
      where expired and not protected and not exists (
        select 1 from filesvc.object_cleanup_jobs j where j.bucket_id=t.bucket_id and j.object_key=t.object_key
      ) order by ready_at,file_id,version_id nulls first limit $2`,
        [CLEANUP_GRACE_SECONDS, limit],
    );
    let scheduled = 0;
    for (const candidate of candidates.rows) {
        scheduled += await transaction(pool, async (client) => {
            const locked = await client.query(`select id from filesvc.files where id=$1 for update skip locked`, [candidate.file_id]);
            if (!locked.rowCount) return 0;
            const t = await targetFor(client, candidate.file_id, candidate.version_id);
            if (!t || !t.expired || t.protected || !valid(t)) return 0;
            const inserted = await client.query(
                `insert into filesvc.object_cleanup_jobs (tenant_id,application_id,file_id,version_id,kind,bucket_id,object_key)
                 values ($1,$2,$3,$4,$5,$6,$7) on conflict (bucket_id,object_key) do nothing returning *`,
                [t.tenant_id, t.application_id, t.file_id, t.version_id, t.kind, t.bucket_id, t.object_key],
            );
            if (!inserted.rowCount) return 0;
            // Mark failed under the same parent lock used by complete/restore before deleting bytes.
            if (t.version_id) await client.query(`update filesvc.file_versions set status='failed' where id=$1`, [t.version_id]);
            else await client.query(`update filesvc.files set status='failed',updated_at=now() where id=$1`, [t.file_id]);
            await audit(client, inserted.rows[0], "file.cleanup_scheduled", "success");
            return 1;
        });
    }
    return scheduled;
}

export async function claimObjectCleanup(pool) {
    return transaction(pool, async (client) => {
        const result = await client.query(`select id from filesvc.object_cleanup_jobs
          where status='pending' and available_at<=now() order by available_at,id for update skip locked limit 1`);
        if (!result.rowCount) return null;
        return (
            await client.query(
                `update filesvc.object_cleanup_jobs
          set available_at=now()+interval '10 minutes',attempts=attempts+1,lease_token=$2
          where id=$1 returning *`,
                [result.rows[0].id, randomUUID()],
            )
        ).rows[0];
    });
}

async function finish(pool, job, status, reason = null) {
    return transaction(pool, async (client) => {
        const parent=await client.query(`select id from filesvc.files
          where id=$1 and tenant_id=$2 and application_id=$3 for update`,[job.file_id,job.tenant_id,job.application_id]);
        if(!parent.rowCount) throw new Error("Cleanup parent is missing");
        const changed = await client.query(
            `update filesvc.object_cleanup_jobs
          set status=$3,finished_at=now(),lease_token=null,last_error_code=$4
          where id=$1 and lease_token=$2 and status='pending' returning id`,
            [job.id, job.lease_token, status, reason],
        );
        if(changed.rowCount && status==="completed") await releaseDeletedStorage(client,
            {tenantId:job.tenant_id,applicationId:job.application_id,fileId:job.file_id},
            [{bucket_id:job.bucket_id,object_key:job.object_key}],{evidence:{cleanupJobId:job.id}});
        if (changed.rowCount)
            await audit(client, job, status === "completed" ? "file.cleanup_completed" : "file.cleanup_skipped", "success", { reason });
        return changed.rowCount === 1;
    });
}

export async function processObjectCleanup(pool, job, removeObject, logger = console) {
    try {
        const decision = await transaction(pool, async (client) => {
            const parent = await client.query(
                `select id from filesvc.files
              where id=$1 and tenant_id=$2 and application_id=$3 for update skip locked`,
                [job.file_id, job.tenant_id, job.application_id],
            );
            if (!parent.rowCount) throw Object.assign(new Error("File is busy or unavailable"), { code: "file_busy" });
            const owned = await client.query(
                `select id from filesvc.object_cleanup_jobs
              where id=$1 and lease_token=$2 and status='pending'`,
                [job.id, job.lease_token],
            );
            if (!owned.rowCount) return { lost: true };
            const t = await targetFor(client, job.file_id, job.version_id);
            if (!t || t.protected || !valid(t) || t.bucket_id !== job.bucket_id || t.object_key !== job.object_key) return { skip: true };
            if (!t.expired) return { wait: t.ready_at };
            // Reaffirm the terminal state even if an operator modified a pending job's source.
            if (t.version_id) await client.query(`update filesvc.file_versions set status='failed' where id=$1`, [t.version_id]);
            else await client.query(`update filesvc.files set status='failed',updated_at=now() where id=$1`, [t.file_id]);
            return { remove: true };
        });
        if (decision.lost) return "lost";
        if (decision.skip) {
            await finish(pool, job, "skipped", "source_protected_or_changed");
            return "skipped";
        }
        if (decision.wait) {
            await pool.query(
                `update filesvc.object_cleanup_jobs set available_at=$3,lease_token=null
              where id=$1 and lease_token=$2 and status='pending'`,
                [job.id, job.lease_token, decision.wait],
            );
            return "deferred";
        }
        await removeObject(job.bucket_id, job.object_key);
        const done = await finish(pool, job, "completed");
        if (done) logger.log("Abandoned object cleanup completed", { jobId: job.id, fileId: job.file_id, versionId: job.version_id });
        return done ? "completed" : "lost";
    } catch (error) {
        const code = typeof error?.code === "string" && /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : "cleanup_failed";
        const seconds = Math.min(30 * 2 ** Math.min(job.attempts, 7), 3600);
        await transaction(pool, async (client) => {
            const updated = await client.query(
                `update filesvc.object_cleanup_jobs
              set available_at=now()+($3::int*interval '1 second'),lease_token=null,last_error_code=$4
              where id=$1 and lease_token=$2 and status='pending' returning id`,
                [job.id, job.lease_token, seconds, code],
            );
            if (updated.rowCount) await audit(client, job, "file.cleanup_failed", "failure", { code, attempts: job.attempts });
        });
        logger.error("Abandoned object cleanup failed; retry scheduled", { jobId: job.id, code, attempts: job.attempts });
        return "retry";
    }
}

export async function runObjectCleanup(pool, removeObject, { limit = 10, stopping = () => false, logger = console } = {}) {
    const scheduled = await scheduleObjectCleanup(pool, limit);
    let processed = 0;
    for (let i = 0; i < limit && !stopping(); i++) {
        const job = await claimObjectCleanup(pool);
        if (!job) break;
        await processObjectCleanup(pool, job, removeObject, logger);
        processed++;
    }
    return { scheduled, processed };
}
