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
}

interface DeletableFileRow {
  id: string;
  bucket_id: string;
  object_key: string;
  status: FileRecord["status"];
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
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<DeletableFileRow>(
        `
          select id, bucket_id, object_key, status
          from filesvc.files
          where id = $1
            and tenant_id = $2
            and application_id = $3
            and owner_subject = $4
            and department_id = any($5::uuid[])
          for update
        `,
        [fileId, scope.tenantId, scope.applicationId, scope.ownerSubject, scope.departmentIds],
      );

      const file = result.rows[0];
      if (!file) {
        await client.query("rollback");
        return "not_found";
      }
      if (file.status === "deleting") {
        await client.query("commit");
        return "already_deleting";
      }
      if (file.status === "deleted") {
        await client.query("commit");
        return "already_deleted";
      }
      if (file.status !== "available") {
        await client.query("rollback");
        return "not_deletable";
      }

      await client.query(
        `
          update filesvc.files
          set status = 'deleting', deleted_at = now(), updated_at = now()
          where id = $1 and tenant_id = $2 and application_id = $3
        `,
        [fileId, scope.tenantId, scope.applicationId],
      );
      await client.query(
        `
          insert into filesvc.outbox (event_type, aggregate_id, payload)
          values ($1, $2, $3::jsonb)
        `,
        [
          "file.object_delete_requested",
          fileId,
          JSON.stringify({
            fileId,
            tenantId: scope.tenantId,
            applicationId: scope.applicationId,
            bucketId: file.bucket_id,
            objectKey: file.object_key,
          }),
        ],
      );
      await client.query("commit");
      return "queued";
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
