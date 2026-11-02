import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { hasDepartmentRole } from "@/application/auth/department-authorization";
import { calculateDepartmentQuota, StorageQuotaError } from "@/domain/storage/department-quota";
import type { DepartmentQuotaRepository } from "./ports/department-quota-repository";

export class GetDepartmentStorageUsage {
    constructor(private readonly repository: DepartmentQuotaRepository) {}

    async execute(app: AuthenticatedApplication, departmentId: string) {
        if (!app.scopes.includes("files:read") || !hasDepartmentRole(app, departmentId, "editor"))
            throw new StorageQuotaError("department_quota_forbidden");
        const quota = await this.repository.find({ tenantId: app.tenantId, applicationId: app.applicationId, departmentId });
        if (!quota) throw new StorageQuotaError("department_quota_not_found");
        return { departmentId, ...calculateDepartmentQuota(quota) };
    }
}
