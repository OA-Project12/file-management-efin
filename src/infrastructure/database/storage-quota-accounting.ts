import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { quotaBytes, StorageQuotaError, type UploadQuotaRejection } from "@/domain/storage/department-quota";
import { recordAudit } from "@/infrastructure/audit/record-audit";

type ObjectInput = {
    fileId: string;
    versionId?: string;
    bucketId: string;
    objectKey: string;
    kind: "initial_upload" | "version_upload" | "version_restore";
    expectedBytes: number;
    expiresAt: Date;
};
type QuotaRow = { limit_bytes: string | null; used_bytes: string; reserved_bytes: string; initialized_at: Date | null };
type Allocation = {
    id: string;
    department_id: string;
    state: string;
    reserved_bytes: string;
    charged_bytes: string;
    file_id: string;
    version_id: string | null;
    kind: string;
};

// Call only inside the caller's transaction, after locking/creating the parent file.
async function department(client: PoolClient, app: AuthenticatedApplication, fileId: string) {
    const file = (
        await client.query<{ department_id: string }>(
            `select department_id from filesvc.files where id=$1 and tenant_id=$2 and application_id=$3`,
            [fileId, app.tenantId, app.applicationId],
        )
    ).rows[0];
    if (!file) throw new StorageQuotaError("quota_file_not_found");
    return file.department_id;
}
async function lockQuota(client: PoolClient, app: AuthenticatedApplication, departmentId: string) {
    const quota = (
        await client.query<QuotaRow>(
            `select limit_bytes::text,used_bytes::text,reserved_bytes::text,initialized_at
         from filesvc.department_storage_quotas where tenant_id=$1 and application_id=$2 and department_id=$3 for update`,
            [app.tenantId, app.applicationId, departmentId],
        )
    ).rows[0];
    if (!quota) throw new StorageQuotaError("department_quota_not_found");
    if (quota.limit_bytes !== null && !quota.initialized_at) throw new StorageQuotaError("quota_accounting_not_ready");
    return quota;
}
async function allocation(client: PoolClient, app: AuthenticatedApplication, input: ObjectInput): Promise<Allocation | undefined> {
    return (
        await client.query<Allocation>(
            `select id,department_id,state,reserved_bytes::text,charged_bytes::text,file_id,version_id,kind
         from filesvc.storage_allocations where tenant_id=$1 and application_id=$2 and bucket_id=$3 and object_key=$4`,
            [app.tenantId, app.applicationId, input.bucketId, input.objectKey],
        )
    ).rows[0];
}

export async function reserveStorage(client: PoolClient, app: AuthenticatedApplication, input: ObjectInput) {
    const amount = quotaBytes(String(input.expectedBytes));
    if (amount === BigInt(0)) throw new StorageQuotaError("invalid_quota_bytes");
    const dept = await department(client, app, input.fileId);
    const quota = await lockQuota(client, app, dept);
    const existing = await allocation(client, app, input);
    if (existing) {
        if (
            existing.file_id !== input.fileId ||
            existing.version_id !== (input.versionId ?? null) ||
            existing.kind !== input.kind ||
            existing.department_id !== dept ||
            existing.state !== "reserved" ||
            BigInt(existing.reserved_bytes) !== amount
        )
            throw new StorageQuotaError("quota_allocation_conflict");
        return;
    }
    // Unlimited/uninitialized departments collect partial accounting until backfill.
    if (quota.limit_bytes !== null && BigInt(quota.used_bytes) + BigInt(quota.reserved_bytes) + amount > BigInt(quota.limit_bytes))
        throw new StorageQuotaError("department_quota_exceeded");
    await client.query(
        `insert into filesvc.storage_allocations
         (tenant_id,application_id,department_id,file_id,version_id,kind,bucket_id,object_key,reserved_bytes,expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10)`,
        [
            app.tenantId,
            app.applicationId,
            dept,
            input.fileId,
            input.versionId ?? null,
            input.kind,
            input.bucketId,
            input.objectKey,
            amount.toString(),
            input.expiresAt,
        ],
    );
    await client.query(
        `update filesvc.department_storage_quotas set reserved_bytes=reserved_bytes+$4::bigint,
      revision=revision+1,updated_at=now() where tenant_id=$1 and application_id=$2 and department_id=$3`,
        [app.tenantId, app.applicationId, dept, amount.toString()],
    );
    await recordAudit(
        app,
        {
            action: "storage.quota_reserved",
            outcome: "success",
            resourceType: "file",
            resourceId: input.fileId,
            details: { departmentId: dept, bytes: amount.toString(), versionId: input.versionId ?? null, kind: input.kind },
        },
        client,
    );
}

export async function settleStorage(
    client: PoolClient,
    app: AuthenticatedApplication,
    input: ObjectInput,
    actualBytes: number,
    forcePending = false,
): Promise<UploadQuotaRejection | null> {
    const actual = quotaBytes(String(actualBytes));
    let entry = await allocation(client, app, input);
    if (!entry) {
        // Older still-pending intents can be adopted while accounting remains uninitialized.
        const dept = await department(client, app, input.fileId);
        const quota = await lockQuota(client, app, dept);
        if (quota.initialized_at) throw new StorageQuotaError("quota_allocation_missing");
        await reserveStorage(client, app, input);
        entry = await allocation(client, app, input);
    }
    if (!entry || entry.file_id !== input.fileId) throw new StorageQuotaError("quota_allocation_missing");
    const quota = await lockQuota(client, app, entry.department_id);
    if (entry.state === "stored") {
        if (BigInt(entry.charged_bytes) !== actual) throw new StorageQuotaError("quota_allocation_conflict");
        return null;
    }
    if (entry.state !== "reserved") throw new StorageQuotaError("quota_allocation_not_reserved");
    const reserved = BigInt(entry.reserved_bytes);
    if (BigInt(quota.reserved_bytes) < reserved) throw new StorageQuotaError("quota_accounting_inconsistent");
    const exceedsSize = actual > reserved;
    const exceedsLimit =
        quota.limit_bytes !== null &&
        BigInt(quota.used_bytes) + BigInt(quota.reserved_bytes) - reserved + actual > BigInt(quota.limit_bytes);
    const rejected: UploadQuotaRejection | null = exceedsSize
        ? "upload_size_exceeds_reservation"
        : exceedsLimit
          ? "department_quota_exceeded"
          : null;
    const pending = forcePending || rejected !== null;
    await client.query(
        `update filesvc.storage_allocations set state=$2,reserved_bytes=0,charged_bytes=$3::bigint,
      object_size_bytes=$3::bigint,version_id=coalesce(version_id,$4::uuid),updated_at=now() where id=$1`,
        [entry.id, pending ? "release_pending" : "stored", actual.toString(), input.versionId ?? null],
    );
    await client.query(
        `update filesvc.department_storage_quotas set reserved_bytes=reserved_bytes-$4::bigint,
      used_bytes=used_bytes+$5::bigint,revision=revision+1,updated_at=now()
      where tenant_id=$1 and application_id=$2 and department_id=$3`,
        [app.tenantId, app.applicationId, entry.department_id, reserved.toString(), actual.toString()],
    );
    await recordAudit(
        app,
        {
            action: pending ? "storage.quota_release_pending" : "storage.quota_stored",
            outcome: "success",
            resourceType: "file",
            resourceId: input.fileId,
            details: { departmentId: entry.department_id, bytes: actual.toString(), versionId: input.versionId ?? null },
        },
        client,
    );
    return rejected;
}

export async function pendingStorageRelease(client: PoolClient, app: AuthenticatedApplication, fileId: string, versionId: string) {
    const row = (
        await client.query<{ id: string; department_id: string }>(
            `select id,department_id from filesvc.storage_allocations
      where tenant_id=$1 and application_id=$2 and file_id=$3 and version_id=$4 and state='reserved'`,
            [app.tenantId, app.applicationId, fileId, versionId],
        )
    ).rows[0];
    if (!row) return;
    await lockQuota(client, app, row.department_id);
    await client.query(`update filesvc.storage_allocations set state='release_pending',updated_at=now() where id=$1`, [row.id]);
    // Keep the reservation charged until cleanup confirms that no object can still exist.
    await recordAudit(
        app,
        {
            action: "storage.quota_release_pending",
            outcome: "success",
            resourceType: "file",
            resourceId: fileId,
            details: { departmentId: row.department_id, versionId },
        },
        client,
    );
}

// Caller holds the document lock. Lock every involved quota in UUID order so
// opposite-direction moves and worker releases cannot form a lock cycle.
export async function transferStorage(
    client: PoolClient,
    app: AuthenticatedApplication,
    fileId: string,
    sourceDepartmentId: string,
    targetDepartmentId: string,
) {
    if (sourceDepartmentId === targetDepartmentId) return;
    const entries = (
        await client.query<Allocation>(
            `select id,department_id,state,reserved_bytes::text,charged_bytes::text,file_id,version_id,kind
      from filesvc.storage_allocations where tenant_id=$1 and application_id=$2 and file_id=$3 and state<>'released'`,
            [app.tenantId, app.applicationId, fileId],
        )
    ).rows;
    const ids = [...new Set([sourceDepartmentId, targetDepartmentId, ...entries.map((row) => row.department_id)])];
    const quotas = (
        await client.query<QuotaRow & { department_id: string }>(
            `select department_id,limit_bytes::text,used_bytes::text,reserved_bytes::text,initialized_at
      from filesvc.department_storage_quotas where tenant_id=$1 and application_id=$2 and department_id=any($3::uuid[])
      order by department_id for update`,
            [app.tenantId, app.applicationId, ids],
        )
    ).rows;
    if (quotas.length !== ids.length) throw new StorageQuotaError("department_quota_not_found");
    const target = quotas.find((row) => row.department_id === targetDepartmentId)!;
    if (target.limit_bytes !== null && !target.initialized_at) throw new StorageQuotaError("quota_accounting_not_ready");
    // Before backfill, moves between unlimited departments can transfer the known
    // partial ledger. An initialized quota must never silently accept missing objects.
    if (quotas.some((row) => row.initialized_at !== null)) {
        const missing = await client.query(
            `with objects as (
          select bucket_id,object_key from filesvc.files where id=$3 and tenant_id=$1 and application_id=$2
          union select v.bucket_id,v.object_key from filesvc.file_versions v where v.file_id=$3
        ) select 1 from objects o where not exists (
          select 1 from filesvc.storage_allocations a where a.tenant_id=$1 and a.application_id=$2 and a.file_id=$3
            and a.bucket_id=o.bucket_id and a.object_key=o.object_key
        ) limit 1`,
            [app.tenantId, app.applicationId, fileId],
        );
        if (missing.rowCount) throw new StorageQuotaError("quota_accounting_not_ready");
    }
    const sums = new Map<string, { used: bigint; reserved: bigint }>();
    let incomingUsed = BigInt(0),
        incomingReserved = BigInt(0);
    for (const entry of entries) {
        if (entry.department_id === targetDepartmentId) continue;
        const amount = sums.get(entry.department_id) ?? { used: BigInt(0), reserved: BigInt(0) };
        amount.used += BigInt(entry.charged_bytes);
        amount.reserved += BigInt(entry.reserved_bytes);
        sums.set(entry.department_id, amount);
        incomingUsed += BigInt(entry.charged_bytes);
        incomingReserved += BigInt(entry.reserved_bytes);
    }
    if (
        target.limit_bytes !== null &&
        incomingUsed + incomingReserved > BigInt(0) &&
        BigInt(target.used_bytes) + BigInt(target.reserved_bytes) + incomingUsed + incomingReserved > BigInt(target.limit_bytes)
    )
        throw new StorageQuotaError("department_quota_exceeded");
    for (const quota of quotas) {
        const amount = sums.get(quota.department_id);
        if (!amount) continue;
        if (BigInt(quota.used_bytes) < amount.used || BigInt(quota.reserved_bytes) < amount.reserved)
            throw new StorageQuotaError("quota_accounting_inconsistent");
        await client.query(
            `update filesvc.department_storage_quotas set used_bytes=used_bytes-$4::bigint,
          reserved_bytes=reserved_bytes-$5::bigint,revision=revision+1,updated_at=now()
          where tenant_id=$1 and application_id=$2 and department_id=$3`,
            [app.tenantId, app.applicationId, quota.department_id, amount.used.toString(), amount.reserved.toString()],
        );
    }
    if (sums.size)
        await client.query(
            `update filesvc.department_storage_quotas set used_bytes=used_bytes+$4::bigint,
      reserved_bytes=reserved_bytes+$5::bigint,revision=revision+1,updated_at=now()
      where tenant_id=$1 and application_id=$2 and department_id=$3`,
            [app.tenantId, app.applicationId, targetDepartmentId, incomingUsed.toString(), incomingReserved.toString()],
        );
    await client.query(
        `update filesvc.storage_allocations set department_id=$4,updated_at=now()
      where tenant_id=$1 and application_id=$2 and file_id=$3 and state<>'released' and department_id<>$4`,
        [app.tenantId, app.applicationId, fileId, targetDepartmentId],
    );
    await recordAudit(
        app,
        {
            action: "storage.quota_transferred",
            outcome: "success",
            resourceType: "file",
            resourceId: fileId,
            details: {
                sourceDepartmentId,
                targetDepartmentId,
                usedBytes: incomingUsed.toString(),
                reservedBytes: incomingReserved.toString(),
                allocationCount: entries.length,
            },
        },
        client,
    );
}
