import { StorageQuotaError } from "@/domain/storage/department-quota";

export function storageQuotaErrorDetails(error: unknown) {
    if (!(error instanceof StorageQuotaError)) return null;
    const known: Record<string, { status: number; message: string }> = {
        department_quota_forbidden: { status: 403, message: "You do not have permission to manage or view storage quota." },
        department_quota_not_found: { status: 404, message: "Department quota was not found." },
        invalid_quota_bytes: { status: 400, message: "Bytes and revision must be canonical non-negative bigint strings." },
        quota_revision_conflict: { status: 409, message: "Storage usage or quota changed. Reload the latest values before saving." },
        quota_limit_below_committed: { status: 409, message: "The limit cannot be lower than used plus reserved storage." },
        department_quota_exceeded: { status: 409, message: "The department does not have enough available storage quota." },
        upload_size_exceeds_reservation: { status: 409, message: "Uploaded bytes exceed the reserved size. The upload was quarantined." },
        quota_allocation_conflict: { status: 409, message: "The storage reservation conflicts with an existing allocation." },
    };
    return {
        code: error.code,
        ...(known[error.code] ?? { status: 503, message: "Storage quota accounting is not ready or could not be verified." }),
        ...(error.details ? { details: error.details } : {}),
    };
}
export function storageQuotaErrorResponse(error: unknown): Response | null {
    const value = storageQuotaErrorDetails(error);
    return value
        ? Response.json(
              { error: { code: value.code, message: value.message, ...(value.details ? { details: value.details } : {}) } },
              { status: value.status, headers: { "Cache-Control": "no-store" } },
          )
        : null;
}
