import "server-only";
import { getDatabasePool } from "@/infrastructure/database/pool";

export interface FolderRecord {
    id: string;
    name: string;
    departmentId: string;
    parentFolderId: string | null;
    createdAt: Date;
    updatedAt: Date;
    visibility: "department" | "restricted";
}

interface FolderRow {
    id: string;
    name: string;
    department_id: string;
    parent_folder_id: string | null;
    created_at: Date;
    updated_at: Date;
    visibility: "department" | "restricted";
}

export class PostgresFolderRepository {
    async list(
        tenantId: string,
        applicationId: string,
        departmentId: string,
        parentFolderId: string | null,
        userId?: string,
        isTenantAdmin = false,
    ): Promise<FolderRecord[]> {
        const result = await getDatabasePool().query<FolderRow>(
            `select id, name, department_id, parent_folder_id, created_at, updated_at, visibility
       from filesvc.folders
       where tenant_id = $1 and application_id = $2 and department_id = $3
         and parent_folder_id is not distinct from $4::uuid
         and ($5::uuid is null or $6::boolean or filesvc.folder_visible(tenant_id, application_id, department_id, id, $5::uuid))
       order by lower(name), id`,
            [tenantId, applicationId, departmentId, parentFolderId, userId ?? null, isTenantAdmin],
        );
        return result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            departmentId: row.department_id,
            parentFolderId: row.parent_folder_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            visibility: row.visibility,
        }));
    }

    async create(input: {
        tenantId: string;
        applicationId: string;
        departmentId: string;
        parentFolderId: string | null;
        name: string;
    }): Promise<FolderRecord | null> {
        const result = await getDatabasePool().query<FolderRow>(
            `insert into filesvc.folders (tenant_id, application_id, department_id, parent_folder_id, name)
       select $1, $2, $3, $4, $5
       where $4::uuid is null or exists (
         select 1 from filesvc.folders
         where id = $4 and tenant_id = $1 and application_id = $2 and department_id = $3
       )
       returning id, name, department_id, parent_folder_id, created_at, updated_at, visibility`,
            [input.tenantId, input.applicationId, input.departmentId, input.parentFolderId, input.name],
        );
        const row = result.rows[0];
        return row
            ? {
                  id: row.id,
                  name: row.name,
                  departmentId: row.department_id,
                  parentFolderId: row.parent_folder_id,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                  visibility: row.visibility,
              }
            : null;
    }
}
