// PostgreSQL int8 values cross service/API boundaries as decimal strings, never Number.
const MAX_INT8 = BigInt("9223372036854775807");
const ZERO = BigInt(0);
export type UploadQuotaRejection = "upload_size_exceeds_reservation" | "department_quota_exceeded";

export class StorageQuotaError extends Error {
    constructor(
        public readonly code: string,
        public readonly details?: Record<string, string | null>,
    ) {
        super(code);
    }
}

export type DepartmentQuota = {
    limitBytes: string | null;
    usedBytes: string;
    reservedBytes: string;
    revision: string;
    initializedAt: Date | null;
};

export function quotaBytes(value: string): bigint {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new StorageQuotaError("invalid_quota_bytes");
    const result = BigInt(value);
    if (result > MAX_INT8) throw new StorageQuotaError("invalid_quota_bytes");
    return result;
}

export function calculateDepartmentQuota(quota: DepartmentQuota) {
    const limit = quota.limitBytes === null ? null : quotaBytes(quota.limitBytes);
    const used = quotaBytes(quota.usedBytes);
    const reserved = quotaBytes(quota.reservedBytes);
    quotaBytes(quota.revision);
    const ready = quota.initializedAt !== null;
    const committed = used + reserved;
    return {
        accountingStatus: ready ? ("ready" as const) : ("pending_backfill" as const),
        limitBytes: limit?.toString() ?? null,
        usedBytes: ready ? used.toString() : null,
        reservedBytes: ready ? reserved.toString() : null,
        committedBytes: ready ? committed.toString() : null,
        availableBytes: ready && limit !== null ? (limit > committed ? limit - committed : ZERO).toString() : null,
        overQuota: ready ? limit !== null && committed > limit : null,
        revision: quota.revision,
    };
}

// Pure advisory calculation. Actual reservations must lock/update counters in a DB transaction.
export function checkDepartmentQuotaCapacity(quota: DepartmentQuota, requestedBytes: string) {
    const requested = quotaBytes(requestedBytes);
    const usage = calculateDepartmentQuota(quota);
    if (usage.accountingStatus !== "ready") throw new StorageQuotaError("quota_accounting_not_ready");
    const committed = quotaBytes(quota.usedBytes) + quotaBytes(quota.reservedBytes);
    return { allowed: quota.limitBytes === null || committed + requested <= quotaBytes(quota.limitBytes), usage };
}
