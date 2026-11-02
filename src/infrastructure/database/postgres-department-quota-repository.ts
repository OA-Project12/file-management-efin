import "server-only";
import type { Pool } from "pg";
import type {
    DepartmentQuotaRepository,
    DepartmentQuotaScope,
    DepartmentQuotaEntry,
} from "@/application/storage/ports/department-quota-repository";
import { StorageQuotaError, type DepartmentQuota } from "@/domain/storage/department-quota";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { recordAudit } from "@/infrastructure/audit/record-audit";
import { getDatabasePool } from "./pool";

export class PostgresDepartmentQuotaRepository implements DepartmentQuotaRepository {
    constructor(private readonly pool: Pool = getDatabasePool()) {}

    async find(scope: DepartmentQuotaScope): Promise<DepartmentQuota | null> {
        const result = await this.pool.query<DepartmentQuota>(
            `select q.limit_bytes::text as "limitBytes",q.used_bytes::text as "usedBytes",
                    q.reserved_bytes::text as "reservedBytes",q.revision::text as revision,
                    q.initialized_at as "initializedAt"
             from filesvc.department_storage_quotas q
             join filesvc.departments d on d.id=q.department_id
               and d.tenant_id=q.tenant_id and d.application_id=q.application_id
             where q.tenant_id=$1 and q.application_id=$2 and q.department_id=$3 and d.status='active'`,
            [scope.tenantId, scope.applicationId, scope.departmentId],
        );
        return result.rows[0] ?? null;
    }

    async list(scope: Omit<DepartmentQuotaScope, "departmentId">, departmentIds: string[], all: boolean): Promise<DepartmentQuotaEntry[]> {
        const result = await this.pool.query<DepartmentQuotaEntry>(
            `select ${QUOTA_COLUMNS} from filesvc.department_storage_quotas q
          join filesvc.departments d on d.id=q.department_id and d.tenant_id=q.tenant_id and d.application_id=q.application_id
          where q.tenant_id=$1 and q.application_id=$2 and d.status='active' and ($3::boolean or d.id=any($4::uuid[]))
          order by lower(d.name),d.id`,
            [scope.tenantId, scope.applicationId, all, departmentIds],
        );
        return result.rows;
    }

    async setLimit(
        app: AuthenticatedApplication,
        departmentId: string,
        limitBytes: string | null,
        expectedRevision: string,
    ): Promise<DepartmentQuotaEntry> {
        const client = await this.pool.connect();
        try {
            await client.query("begin");
            const entry = (
                await client.query<DepartmentQuotaEntry>(
                    `select ${QUOTA_COLUMNS} from filesvc.department_storage_quotas q
              join filesvc.departments d on d.id=q.department_id and d.tenant_id=q.tenant_id and d.application_id=q.application_id
              where q.tenant_id=$1 and q.application_id=$2 and q.department_id=$3 and d.status='active' for update of q`,
                    [app.tenantId, app.applicationId, departmentId],
                )
            ).rows[0];
            if (!entry) throw new StorageQuotaError("department_quota_not_found");
            if (entry.revision !== expectedRevision) throw new StorageQuotaError("quota_revision_conflict", { revision: entry.revision });
            if (limitBytes !== null && !entry.initializedAt) throw new StorageQuotaError("quota_accounting_not_ready");
            if (entry.limitBytes !== limitBytes) {
                const committed = (BigInt(entry.usedBytes) + BigInt(entry.reservedBytes)).toString();
                if (limitBytes !== null && BigInt(limitBytes) < BigInt(committed))
                    throw new StorageQuotaError("quota_limit_below_committed", { minimumLimitBytes: committed });
                const revision = (
                    await client.query<{ revision: string }>(
                        `update filesvc.department_storage_quotas set limit_bytes=$4::bigint,
                  revision=revision+1,updated_at=now() where tenant_id=$1 and application_id=$2 and department_id=$3 returning revision::text`,
                        [app.tenantId, app.applicationId, departmentId, limitBytes],
                    )
                ).rows[0].revision;
                await recordAudit(
                    app,
                    {
                        action: "department.quota_update",
                        outcome: "success",
                        resourceType: "department",
                        resourceId: departmentId,
                        details: {
                            beforeLimitBytes: entry.limitBytes,
                            afterLimitBytes: limitBytes,
                            usedBytes: entry.usedBytes,
                            reservedBytes: entry.reservedBytes,
                        },
                    },
                    client,
                );
                entry.limitBytes = limitBytes;
                entry.revision = revision;
            }
            await client.query("commit");
            return entry;
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}

const QUOTA_COLUMNS = `q.department_id as "departmentId",d.name as "departmentName",q.limit_bytes::text as "limitBytes",
 q.used_bytes::text as "usedBytes",q.reserved_bytes::text as "reservedBytes",q.revision::text as revision,q.initialized_at as "initializedAt"`;
