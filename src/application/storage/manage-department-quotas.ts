import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { departmentIdsForRole } from "@/application/auth/department-authorization";
import { calculateDepartmentQuota, quotaBytes, StorageQuotaError } from "@/domain/storage/department-quota";
import type { DepartmentQuotaRepository, DepartmentQuotaEntry } from "./ports/department-quota-repository";

export const canManageStorageQuota = (app: AuthenticatedApplication) => Boolean(app.userId && app.isTenantAdmin);
export function quotaView(entry: DepartmentQuotaEntry, canManageQuota: boolean) {
    return { departmentId: entry.departmentId, departmentName: entry.departmentName, ...calculateDepartmentQuota(entry), canManageQuota };
}
export type StorageQuotaItem = ReturnType<typeof quotaView>;

export class ManageDepartmentQuotas {
    constructor(private readonly repository: DepartmentQuotaRepository) {}
    async list(app: AuthenticatedApplication) {
        if (!app.scopes.includes("files:read")) throw new StorageQuotaError("department_quota_forbidden");
        const canManage = canManageStorageQuota(app);
        const entries = await this.repository.list(app, departmentIdsForRole(app, "editor"), canManage);
        return { items: entries.map((entry) => quotaView(entry, canManage)) };
    }
    async setLimit(app: AuthenticatedApplication, departmentId: string, limitBytes: string | null, expectedRevision: string) {
        if (!canManageStorageQuota(app)) throw new StorageQuotaError("department_quota_forbidden");
        if (limitBytes !== null) quotaBytes(limitBytes);
        quotaBytes(expectedRevision);
        return quotaView(await this.repository.setLimit(app, departmentId, limitBytes, expectedRevision), true);
    }
}
