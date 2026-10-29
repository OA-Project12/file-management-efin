import "server-only";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { getDatabasePool } from "@/infrastructure/database/pool";

// Server API keys are trusted integration credentials; the per-user allowlist applies to Auth users.
export async function canSeeFolder(app: AuthenticatedApplication, departmentId: string, folderId: string | null): Promise<boolean> {
    if (!app.userId || app.isTenantAdmin || folderId === null) return true;
    const result = await getDatabasePool().query<{ allowed: boolean }>(
        `select filesvc.folder_visible($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid) as allowed`,
        [app.tenantId, app.applicationId, departmentId, folderId, app.userId],
    );
    return result.rows[0]?.allowed === true;
}

export async function canSeeFile(app: AuthenticatedApplication, fileId: string): Promise<boolean> {
    if (!app.userId || app.isTenantAdmin) return true;
    const result = await getDatabasePool().query<{ allowed: boolean }>(
        `select filesvc.folder_visible(f.tenant_id, f.application_id, f.department_id, f.folder_id, $4::uuid) as allowed
     from filesvc.files f where f.id = $1 and f.tenant_id = $2 and f.application_id = $3`,
        [fileId, app.tenantId, app.applicationId, app.userId],
    );
    return result.rows[0]?.allowed === true;
}
