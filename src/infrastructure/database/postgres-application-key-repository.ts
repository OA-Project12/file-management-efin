import "server-only";
import type { QueryResultRow } from "pg";
import type { DepartmentGrant } from "@/application/auth/authenticated-application";
import { getDatabasePool } from "@/infrastructure/database/pool";

export interface ApplicationKeyRecord {
  id: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  departmentGrants: Array<Pick<DepartmentGrant, "id" | "code" | "name" | "role">>;
}

interface ApplicationKeyRow extends QueryResultRow {
  id: string;
  key_prefix: string;
  scopes: string[];
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  department_grants: ApplicationKeyRecord["departmentGrants"] | null;
}

function mapKey(row: ApplicationKeyRow): ApplicationKeyRecord {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    scopes: row.scopes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    departmentGrants: row.department_grants ?? [],
  };
}

export class PostgresApplicationKeyRepository {
  async listForApplication(tenantId: string, applicationId: string, departmentIds: string[], isApplicationAdmin: boolean): Promise<ApplicationKeyRecord[]> {
    const result = await getDatabasePool().query<ApplicationKeyRow>(
      `
        select k.id, k.key_prefix, k.scopes, k.created_at, k.expires_at, k.revoked_at, k.last_used_at,
               coalesce(jsonb_agg(jsonb_build_object(
                 'id', d.id, 'code', d.code, 'name', d.name, 'role', kd.role
               )) filter (where d.id is not null), '[]'::jsonb) as department_grants
        from filesvc.application_keys k
        left join filesvc.application_key_departments kd on kd.application_key_id = k.id
        left join filesvc.departments d on d.id = kd.department_id
        where k.tenant_id = $1 and k.application_id = $2
          and (
            $4::boolean or (
              exists (
                select 1 from filesvc.application_key_departments visible
                where visible.application_key_id = k.id and visible.department_id = any($3::uuid[])
              )
              and not exists (
                select 1 from filesvc.application_key_departments hidden
                where hidden.application_key_id = k.id and not (hidden.department_id = any($3::uuid[]))
              )
            )
          )
        group by k.id
        order by k.created_at desc, k.id desc
      `,
      [tenantId, applicationId, departmentIds, isApplicationAdmin],
    );

    return result.rows.map(mapKey);
  }

  async createForApplication(input: {
    tenantId: string;
    applicationId: string;
    keyPrefix: string;
    secretHash: Buffer;
    scopes: string[];
    expiresInDays: number;
    departmentGrants: Array<Pick<DepartmentGrant, "id" | "code" | "name" | "role">>;
  }): Promise<ApplicationKeyRecord | null> {
    const client = await getDatabasePool().connect();
    try {
      await client.query("begin");
      const result = await client.query<ApplicationKeyRow>(
        `
        insert into filesvc.application_keys (
          tenant_id, application_id, key_prefix, secret_hash, scopes, expires_at
        )
        select a.tenant_id, a.id, $3, $4, $5::text[], now() + ($6::int * interval '1 day')
        from filesvc.applications a
        join filesvc.tenants t on t.id = a.tenant_id
        where a.id = $2 and a.tenant_id = $1
          and a.status = 'active' and t.status = 'active'
        returning id, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at,
                  '[]'::jsonb as department_grants
      `,
      [
        input.tenantId,
        input.applicationId,
        input.keyPrefix,
        input.secretHash,
        input.scopes,
        input.expiresInDays,
      ],
      );
      const row = result.rows[0];
      if (!row) {
        await client.query("rollback");
        return null;
      }
      for (const grant of input.departmentGrants) {
        const grantResult = await client.query(
          `insert into filesvc.application_key_departments (application_key_id, department_id, role)
           select $1, d.id, $3 from filesvc.departments d
           where d.id = $2 and d.tenant_id = $4 and d.application_id = $5 and d.status = 'active'`,
          [row.id, grant.id, grant.role, input.tenantId, input.applicationId],
        );
        if (grantResult.rowCount !== 1) throw new Error("Department grant could not be assigned.");
      }
      await client.query("commit");
      return { ...mapKey(row), departmentGrants: input.departmentGrants };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeForApplication(
    tenantId: string,
    applicationId: string,
    keyId: string,
    departmentIds: string[],
    isApplicationAdmin: boolean,
  ): Promise<ApplicationKeyRecord | null> {
    const result = await getDatabasePool().query<ApplicationKeyRow>(
      `
        update filesvc.application_keys
        set revoked_at = coalesce(revoked_at, now())
        where tenant_id = $1 and application_id = $2 and id = $3
          and (
            $5::boolean or (
              not ('departments:manage' = any(scopes))
              and exists (
                select 1 from filesvc.application_key_departments visible
                where visible.application_key_id = application_keys.id and visible.department_id = any($4::uuid[])
              )
              and not exists (
                select 1 from filesvc.application_key_departments hidden
                where hidden.application_key_id = application_keys.id and not (hidden.department_id = any($4::uuid[]))
              )
            )
          )
        returning id, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at
      `,
      [tenantId, applicationId, keyId, departmentIds, isApplicationAdmin],
    );

    return result.rows[0] ? mapKey(result.rows[0]) : null;
  }
}
