import "server-only";
import { Pool } from "pg";
import type { FileRecord } from "@/domain/files/file-record";
import type {
  FileListItem,
  FileDeletionRequestResult,
  FilePagePosition,
  FileSearchFilters,
  FileRepository,
  FileScope,
} from "@/application/files/ports/file-repository";
import { getDatabasePool } from "@/infrastructure/database/pool";

interface FileRow {
  id: string;
  tenant_id: string;
  application_id: string;
  owner_subject: string;
  bucket_id: string;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: string;
  status: FileRecord["status"];
  created_at: Date;
}

interface FileListRow {
  id: string;
  original_name: string;
  display_name: string;
  content_type: string;
  size_bytes: string;
  folder_id: string | null;
  department_id: string;
  department: string;
  tags: string[];
  created_at: Date;
  trashed_at?: Date;
}

interface DeletableFileRow {
  id: string;
  status: FileRecord["status"];
  trashed_at: Date | null;
}

export class PostgresFileRepository implements FileRepository {
  constructor(private readonly pool: Pool = getDatabasePool()) {}

  async findAvailableById(fileId: string, scope: FileScope): Promise<FileRecord | null> {
    const result = await this.pool.query<FileRow>(
      `select id, tenant_id, application_id, owner_subject, bucket_id,
              object_key, original_name, content_type, size_bytes, status, created_at
       from filesvc.files
       where id = $1
         and tenant_id = $2
         and application_id = $3
         and owner_subject = $4
         and department_id = any($5::uuid[])
         and status = 'available'`,
      [fileId, scope.tenantId, scope.applicationId, scope.ownerSubject, scope.departmentIds],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      id: row.id,
      tenantId: row.tenant_id,
      applicationId: row.application_id,
      ownerSubject: row.owner_subject,
      bucketId: row.bucket_id,
      objectKey: row.object_key,
      originalName: row.original_name,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  async listAvailable(
    scope: FileScope,
    limit: number,
    before?: FilePagePosition,
    filters: FileSearchFilters = {},
  ): Promise<FileListItem[]> {
    const result = await this.pool.query<FileListRow>(
      `
        select f.id, f.original_name, f.display_name, f.content_type, f.size_bytes,
               f.folder_id, f.department_id, d.name as department, f.tags, f.created_at
        from filesvc.files f
        join filesvc.departments d
          on d.id = f.department_id and d.tenant_id = f.tenant_id and d.application_id = f.application_id
        where f.tenant_id = $1
          and f.application_id = $2
          and f.owner_subject = $3
          and f.status = 'available'
          and f.deleted_at is null
          and f.department_id = any($10::uuid[])
          and ($7::uuid is null or f.folder_id = $7)
          and ($8::uuid is null or f.department_id = $8)
          and ($9::text is null or $9 = any(f.tags))
          and ($11::text is null or lower(f.content_type) = $11)
          and ($12::timestamptz is null or f.created_at >= $12)
          and ($13::timestamptz is null or f.created_at < $13)
          and ($4::timestamptz is null or (f.created_at, f.id) < ($4::timestamptz, $5::uuid))
        order by f.created_at desc, f.id desc
        limit $6
      `,
      [
        scope.tenantId,
        scope.applicationId,
        scope.ownerSubject,
        before?.createdAt.toISOString() ?? null,
        before?.fileId ?? null,
        limit,
        filters.folderId ?? null,
        filters.departmentId ?? null,
        filters.tag ?? null,
        scope.departmentIds,
        filters.contentType ?? null,
        filters.createdFrom ?? null,
        filters.createdBefore ?? null,
      ],
    );

    return result.rows.map((row) => ({
      id: row.id,
      originalName: row.original_name,
      displayName: row.display_name,
      contentType: row.content_type,
      sizeBytes: row.size_bytes,
      folderId: row.folder_id,
      departmentId: row.department_id,
      department: row.department,
      tags: row.tags,
      createdAt: row.created_at,
    }));
  }

  async requestDelete(fileId: string, scope: FileScope): Promise<FileDeletionRequestResult> {
    const result = await this.pool.query<DeletableFileRow>(
        `
          select id, status, trashed_at
          from filesvc.files
          where id = $1
            and tenant_id = $2
            and application_id = $3
            and owner_subject = $4
            and department_id = any($5::uuid[])
        `,
        [fileId, scope.tenantId, scope.applicationId, scope.ownerSubject, scope.departmentIds],
    );

    const file = result.rows[0];
    if (!file) return "not_found";
    if (file.status === "deleted") return file.trashed_at ? "already_deleted" : "not_deletable";
    if (file.status !== "available") return "not_deletable";

    const updated = await this.pool.query(
      `update filesvc.files set status = 'deleted', deleted_at = now(), trashed_at = now(), updated_at = now()
       where id = $1 and tenant_id = $2 and application_id = $3 and owner_subject = $4
         and department_id = any($5::uuid[]) and status = 'available'
       returning id`,
      [fileId, scope.tenantId, scope.applicationId, scope.ownerSubject, scope.departmentIds],
    );
    return updated.rowCount ? "trashed" : "not_deletable";
  }

  async listTrash(scope: FileScope, departmentId?: string): Promise<FileListItem[]> {
    const result = await this.pool.query<FileListRow>(
      `select f.id, f.original_name, f.display_name, f.content_type, f.size_bytes,
              f.folder_id, f.department_id, d.name as department, f.tags, f.created_at, f.trashed_at
       from filesvc.files f
       join filesvc.departments d on d.id = f.department_id and d.tenant_id = f.tenant_id and d.application_id = f.application_id
       where f.tenant_id = $1 and f.application_id = $2 and f.owner_subject = $3
         and f.department_id = any($4::uuid[]) and f.status = 'deleted' and f.trashed_at is not null
         and ($5::uuid is null or f.department_id = $5)
       order by f.trashed_at desc, f.id desc limit 100`,
      [scope.tenantId, scope.applicationId, scope.ownerSubject, scope.departmentIds, departmentId ?? null],
    );
    return result.rows.map((row) => ({
      id: row.id, originalName: row.original_name, displayName: row.display_name,
      contentType: row.content_type, sizeBytes: row.size_bytes, folderId: row.folder_id,
      departmentId: row.department_id, department: row.department, tags: row.tags,
      createdAt: row.created_at, trashedAt: row.trashed_at,
    }));
  }

  async restore(fileId: string, scope: FileScope): Promise<"restored" | "not_found"> {
    const result = await this.pool.query(
      `update filesvc.files set status = 'available', deleted_at = null, trashed_at = null, updated_at = now()
       where id = $1 and tenant_id = $2 and application_id = $3 and owner_subject = $4
         and department_id = any($5::uuid[]) and status = 'deleted' and trashed_at is not null
       returning id`,
      [fileId, scope.tenantId, scope.applicationId, scope.ownerSubject, scope.departmentIds],
    );
    return result.rowCount ? "restored" : "not_found";
  }
}
