import "server-only";
import type { Pool } from "pg";
import type {
  CreatePendingUploadInput,
  PendingUpload,
  UploadIntentRepository,
  UploadRecord,
} from "@/application/files/ports/upload-intent-repository";
import { getDatabasePool } from "@/infrastructure/database/pool";

interface UploadIntentRow {
  file_id: string;
  expires_at: Date;
}

interface UploadRecordRow {
  file_id: string;
  bucket_id: string;
  object_key: string;
  size_bytes: string;
  content_type: string;
  department_id: string;
  status: string;
  expires_at: Date;
  completed_at: Date | null;
}

export class PostgresUploadIntentRepository implements UploadIntentRepository {
  constructor(private readonly pool: Pool = getDatabasePool()) {}

  async createPendingUpload(input: CreatePendingUploadInput): Promise<PendingUpload> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      await client.query(
        `
          insert into filesvc.files (
            id, tenant_id, application_id, department_id, owner_subject, bucket_id, object_key,
            original_name, display_name, content_type, size_bytes, checksum_sha256
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)
        `,
        [
          input.fileId,
          input.tenantId,
          input.applicationId,
          input.departmentId,
          input.ownerSubject,
          input.bucketId,
          input.objectKey,
          input.originalName,
          input.contentType,
          input.sizeBytes,
          input.checksumSha256,
        ],
      );

      const intentResult = await client.query<UploadIntentRow>(
        `
          insert into filesvc.upload_intents (file_id, token_fingerprint, expires_at)
          values ($1, $2, now() + ($3::int * interval '1 second'))
          returning file_id, expires_at
        `,
        [input.fileId, input.tokenFingerprint, input.expiresInSeconds],
      );

      await client.query("commit");
      return {
        fileId: intentResult.rows[0].file_id,
        expiresAt: intentResult.rows[0].expires_at,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findUpload(
    fileId: string,
    tenantId: string,
    applicationId: string,
  ): Promise<UploadRecord | null> {
    const result = await this.pool.query<UploadRecordRow>(
      `
        select f.id as file_id, f.bucket_id, f.object_key, f.size_bytes,
               f.content_type, f.department_id, f.status, ui.expires_at, ui.completed_at
        from filesvc.files f
        join filesvc.upload_intents ui on ui.file_id = f.id
        where f.id = $1 and f.tenant_id = $2 and f.application_id = $3
        limit 1
      `,
      [fileId, tenantId, applicationId],
    );

    const row = result.rows[0];
    if (!row) return null;
    return {
      fileId: row.file_id,
      bucketId: row.bucket_id,
      objectKey: row.object_key,
      sizeBytes: Number(row.size_bytes),
      contentType: row.content_type,
      departmentId: row.department_id,
      status: row.status,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
    };
  }

  async completeUpload(
    fileId: string,
    tenantId: string,
    applicationId: string,
    departmentIds: string[],
    actualSizeBytes: number,
    actualContentType: string,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const intent = await client.query(
        `
          update filesvc.upload_intents ui
          set completed_at = now()
          from filesvc.files f
          where ui.file_id = f.id
            and ui.file_id = $1
            and f.tenant_id = $2
            and f.application_id = $3
            and f.department_id = any($4::uuid[])
            and ui.completed_at is null
            and ui.expires_at > now()
            and f.status = 'pending_upload'
          returning ui.file_id
        `,
        [fileId, tenantId, applicationId, departmentIds],
      );

      if (intent.rowCount !== 1) {
        await client.query("rollback");
        return false;
      }

      await client.query(
        `
          update filesvc.files
          set status = 'available', size_bytes = $4, content_type = $5, updated_at = now()
          where id = $1 and tenant_id = $2 and application_id = $3
            and status = 'pending_upload'
        `,
        [fileId, tenantId, applicationId, actualSizeBytes, actualContentType],
      );
      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async quarantineUpload(fileId: string, tenantId: string, applicationId: string): Promise<void> {
    await this.pool.query(
      `
        update filesvc.files
        set status = 'quarantined', updated_at = now()
        where id = $1 and tenant_id = $2 and application_id = $3
          and status = 'pending_upload'
      `,
      [fileId, tenantId, applicationId],
    );
  }
}
