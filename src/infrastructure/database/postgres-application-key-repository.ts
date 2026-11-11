import "server-only";
import type { QueryResultRow } from "pg";
import type { AuthenticatedApplication, DepartmentGrant } from "@/application/auth/authenticated-application";
import { getDatabasePool } from "@/infrastructure/database/pool";
import { recordAudit } from "@/infrastructure/audit/record-audit";

export interface ApplicationKeyRecord {
    id: string;
    keyPrefix: string;
    scopes: string[];
    createdAt: Date;
    expiresAt: Date | null;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    rotatedFromKeyId: string | null;
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
    rotated_from_key_id?: string | null;
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
        rotatedFromKeyId: row.rotated_from_key_id ?? null,
        departmentGrants: row.department_grants ?? [],
    };
}

type RotationResult =
    | { status: "rotated"; key: ApplicationKeyRecord; oldExpiresAt: Date }
    | { status: "already_rotated"; replacementId: string }
    | { status: "unauthorized" | "forbidden" | "not_found" | "not_rotatable" };

export class PostgresApplicationKeyRepository {
    async listForApplication(
        tenantId: string,
        applicationId: string,
        departmentIds: string[],
        isApplicationAdmin: boolean,
    ): Promise<ApplicationKeyRecord[]> {
        const result = await getDatabasePool().query<ApplicationKeyRow>(
            `
        select k.id, k.key_prefix, k.scopes, k.created_at, k.expires_at, k.revoked_at, k.last_used_at, k.rotated_from_key_id,
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
        auditActor: AuthenticatedApplication;
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
                [input.tenantId, input.applicationId, input.keyPrefix, input.secretHash, input.scopes, input.expiresInDays],
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
            await recordAudit(
                input.auditActor,
                {
                    action: "key.create",
                    outcome: "success",
                    resourceType: "api_key",
                    resourceId: row.id,
                    details: {
                        grantCount: input.departmentGrants.length,
                        grants: input.departmentGrants
                            .map((grant) => `${grant.id}:${grant.role}`)
                            .sort()
                            .join(","),
                        expiresInDays: input.expiresInDays,
                    },
                },
                client,
            );
            await client.query("commit");
            return { ...mapKey(row), departmentGrants: input.departmentGrants };
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    async rotateForApplication(input: {
        actor: AuthenticatedApplication;
        keyId: string;
        keyPrefix: string;
        secretHash: Buffer;
        expiresInDays: number;
    }): Promise<RotationResult> {
        const { actor, keyId } = input;
        const scope = [actor.tenantId, actor.applicationId, actor.keyId, keyId];
        const client = await getDatabasePool().connect();
        let committed = false;
        try {
            await client.query("begin");
            // Serialize rotations and revocations of either key. Check expiry after any lock wait.
            await client.query(
                `select id from filesvc.application_keys
                 where tenant_id = $1 and application_id = $2 and id in ($3, $4)
                 order by id for update`,
                scope,
            );
            const { rows: keys } = await client.query<{ id: string; scopes: string[]; usable: boolean }>(
                `select k.id, k.scopes,
                        k.revoked_at is null and (k.expires_at is null or k.expires_at > statement_timestamp()) as usable
                 from filesvc.application_keys k
                 join filesvc.applications a on a.id = k.application_id and a.tenant_id = k.tenant_id and a.status = 'active'
                 join filesvc.tenants t on t.id = k.tenant_id and t.status = 'active'
                 where k.tenant_id = $1 and k.application_id = $2 and k.id in ($3, $4)`,
                scope,
            );
            const manager = keys.find((key) => key.id === actor.keyId);
            if (!manager?.usable) return { status: "unauthorized" };
            if (!manager.scopes.includes("keys:manage")) return { status: "forbidden" };
            const source = keys.find((key) => key.id === keyId);
            if (!source) return { status: "not_found" };

            const isApplicationAdmin = manager.scopes.includes("departments:manage");
            const { rows: grants } = await client.query<DepartmentGrant & { can_admin: boolean }>(
                `select d.id, d.code, d.name, target.role,
                        (d.tenant_id = $1 and d.application_id = $2 and d.status = 'active'
                         and ($5::boolean or manager.role = 'admin')) is true as can_admin
                 from filesvc.application_key_departments target
                 join filesvc.departments d on d.id = target.department_id
                 left join filesvc.application_key_departments manager
                   on manager.application_key_id = $3 and manager.department_id = d.id
                 where target.application_key_id = $4
                 order by d.id`,
                [...scope, isApplicationAdmin],
            );
            if (grants.some((grant) => !grant.can_admin) || (!isApplicationAdmin && grants.length === 0))
                return { status: "not_found" };

            const { rows: [replacement] } = await client.query<{ id: string }>(
                `select id from filesvc.application_keys
                 where tenant_id = $1 and application_id = $2 and rotated_from_key_id = $3`,
                [actor.tenantId, actor.applicationId, keyId],
            );
            if (replacement) return { status: "already_rotated", replacementId: replacement.id };
            if (!source.usable || grants.length === 0 || source.scopes.length === 0 ||
                source.scopes.some((scope) => scope !== "files:read" && scope !== "files:write"))
                return { status: "not_rotatable" };

            const { rows: [oldKey] } = await client.query<{ expires_at: Date }>(
                `update filesvc.application_keys
                 set expires_at = least(expires_at, statement_timestamp() + interval '24 hours')
                 where id = $1 and (expires_at is null or expires_at > statement_timestamp())
                 returning expires_at`,
                [keyId],
            );
            if (!oldKey) return { status: "not_rotatable" };
            const { rows: [created] } = await client.query<ApplicationKeyRow>(
                `insert into filesvc.application_keys
                    (tenant_id, application_id, key_prefix, secret_hash, scopes, expires_at, rotated_from_key_id)
                 values ($1, $2, $3, $4, $5, statement_timestamp() + ($6::int * interval '1 day'), $7)
                 returning id, key_prefix, scopes, created_at, expires_at, revoked_at, last_used_at, rotated_from_key_id`,
                [actor.tenantId, actor.applicationId, input.keyPrefix, input.secretHash, source.scopes, input.expiresInDays, keyId],
            );
            const departmentGrants = grants.map(({ id, code, name, role }) => ({ id, code, name, role }));
            await client.query(
                `insert into filesvc.application_key_departments (application_key_id, department_id, role)
                 select $1, department_id, role
                 from unnest($2::uuid[], $3::text[]) as grants(department_id, role)`,
                [created.id, departmentGrants.map((grant) => grant.id), departmentGrants.map((grant) => grant.role)],
            );
            await recordAudit(
                actor,
                {
                    action: "key.rotate",
                    outcome: "success",
                    resourceType: "api_key",
                    resourceId: keyId,
                    details: {
                        replacementId: created.id,
                        oldExpiresAt: oldKey.expires_at.toISOString(),
                        newExpiresAt: created.expires_at!.toISOString(),
                    },
                },
                client,
            );
            await client.query("commit");
            committed = true;
            return { status: "rotated", key: { ...mapKey(created), departmentGrants }, oldExpiresAt: oldKey.expires_at };
        } finally {
            if (!committed) await client.query("rollback").catch(() => undefined);
            client.release();
        }
    }

    async revokeForApplication(
        auditActor: AuthenticatedApplication,
        tenantId: string,
        applicationId: string,
        keyId: string,
        departmentIds: string[],
        isApplicationAdmin: boolean,
    ): Promise<ApplicationKeyRecord | null> {
        const client = await getDatabasePool().connect();
        try {
            await client.query("begin");
            const result = await client.query<ApplicationKeyRow>(
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

            if (result.rows[0])
                await recordAudit(
                    auditActor,
                    { action: "key.revoke", outcome: "success", resourceType: "api_key", resourceId: keyId },
                    client,
                );
            await client.query("commit");
            return result.rows[0] ? mapKey(result.rows[0]) : null;
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}
