import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { AuthenticatedApplication, DepartmentGrant } from "@/application/auth/authenticated-application";
import { getDatabasePool } from "@/infrastructure/database/pool";

interface ApplicationKeyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  application_id: string;
  secret_hash: Buffer;
  scopes: string[];
}

const API_KEY_PATTERN = /^fsvc_([a-f0-9]{12})\.([A-Za-z0-9_-]{43})$/i;

export async function authenticateApplicationKey(
  request: Request,
): Promise<AuthenticatedApplication | null> {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!bearerMatch || bearerMatch[1].length > 96) return null;

  const keyMatch = API_KEY_PATTERN.exec(bearerMatch[1]);
  if (!keyMatch) return null;

  const keyPrefix = `fsvc_${keyMatch[1].toLowerCase()}`;
  const presentedSecret = keyMatch[2];
  const pool = getDatabasePool();

  const result = await pool.query<ApplicationKeyRow>(
    `
      select k.id, k.tenant_id, k.application_id, k.secret_hash, k.scopes
      from filesvc.application_keys k
      join filesvc.applications a
        on a.id = k.application_id and a.tenant_id = k.tenant_id
      join filesvc.tenants t on t.id = k.tenant_id
      where k.key_prefix = $1
        and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
        and a.status = 'active'
        and t.status = 'active'
      limit 1
    `,
    [keyPrefix],
  );

  const key = result.rows[0];
  if (!key || !Buffer.isBuffer(key.secret_hash)) return null;

  const presentedHash = createHash("sha256").update(presentedSecret, "utf8").digest();
  if (key.secret_hash.length !== presentedHash.length || !timingSafeEqual(key.secret_hash, presentedHash)) {
    return null;
  }

  // Re-check revocation, expiry, and parent status so a concurrent suspension
  // or revocation between lookup and use cannot validate a stale key.
  const touchResult = await pool.query(
    `
      update filesvc.application_keys k
      set last_used_at = now()
      where k.id = $1
        and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
        and exists (
          select 1
          from filesvc.applications a
          join filesvc.tenants t on t.id = a.tenant_id
          where a.id = k.application_id
            and a.tenant_id = k.tenant_id
            and a.status = 'active'
            and t.status = 'active'
        )
      returning k.id
    `,
    [key.id],
  );

  if (touchResult.rowCount !== 1) return null;

  const departmentResult = await pool.query<DepartmentGrant & QueryResultRow>(
    `
      select d.id, d.code, d.name,
             case when $2::boolean then 'admin' else kd.role end as role
      from filesvc.departments d
      left join filesvc.application_key_departments kd
        on kd.department_id = d.id and kd.application_key_id = $1
      where d.tenant_id = $3 and d.application_id = $4 and d.status = 'active'
        and ($2::boolean or kd.application_key_id is not null)
      order by lower(d.name), d.id
    `,
    [key.id, key.scopes.includes("departments:manage"), key.tenant_id, key.application_id],
  );

  return {
    keyId: key.id,
    tenantId: key.tenant_id,
    applicationId: key.application_id,
    scopes: key.scopes,
    departments: departmentResult.rows,
  };
}
