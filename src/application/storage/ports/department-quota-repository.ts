import type { DepartmentQuota } from "@/domain/storage/department-quota";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";

export type DepartmentQuotaScope = { tenantId: string; applicationId: string; departmentId: string };
export type DepartmentQuotaEntry = DepartmentQuota & { departmentId: string; departmentName: string };
export interface DepartmentQuotaRepository {
    find(scope: DepartmentQuotaScope): Promise<DepartmentQuota | null>;
    list(scope: Omit<DepartmentQuotaScope, "departmentId">, departmentIds: string[], all: boolean): Promise<DepartmentQuotaEntry[]>;
    setLimit(
        app: AuthenticatedApplication,
        departmentId: string,
        limitBytes: string | null,
        expectedRevision: string,
    ): Promise<DepartmentQuotaEntry>;
}
