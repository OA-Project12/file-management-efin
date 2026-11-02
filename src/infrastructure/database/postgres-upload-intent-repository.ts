import "server-only";
import type { Pool } from "pg";
import type {
    CreatePendingUploadInput,
    PendingUpload,
    UploadIntentRepository,
    UploadRecord,
} from "@/application/files/ports/upload-intent-repository";
import { getDatabasePool } from "@/infrastructure/database/pool";
import { recordAudit } from "@/infrastructure/audit/record-audit";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { reserveStorage,settleStorage } from "./storage-quota-accounting";
import type { UploadQuotaRejection } from "@/domain/storage/department-quota";

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

            await reserveStorage(client,input.auditActor,{fileId:input.fileId,bucketId:input.bucketId,objectKey:input.objectKey,
                kind:"initial_upload",expectedBytes:input.sizeBytes,expiresAt:intentResult.rows[0].expires_at});
            await recordAudit(
                input.auditActor,
                {
                    action: "file.upload_intent",
                    outcome: "success",
                    resourceType: "file",
                    resourceId: input.fileId,
                    details: { departmentId: input.departmentId, sizeBytes: input.sizeBytes, contentType: input.contentType },
                },
                client,
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

    async findUpload(fileId: string, tenantId: string, applicationId: string): Promise<UploadRecord | null> {
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
        auditActor: AuthenticatedApplication,
        fileId: string,
        tenantId: string,
        applicationId: string,
        departmentIds: string[],
        actualSizeBytes: number,
        actualContentType: string,
    ): Promise<boolean | UploadQuotaRejection> {
        const client = await this.pool.connect();
        try {
            await client.query("begin");
            // Match the cleanup/version paths: lock the document before its intent.
            await client.query(
                `select id from filesvc.files where id=$1 and tenant_id=$2 and application_id=$3 for update`,
                [fileId,tenantId,applicationId],
            );
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

            const source=(await client.query<{bucket_id:string;object_key:string;size_bytes:string;expires_at:Date}>(
                `select f.bucket_id,f.object_key,f.size_bytes,ui.expires_at from filesvc.files f
                 join filesvc.upload_intents ui on ui.file_id=f.id where f.id=$1`,[fileId],
            )).rows[0];
            const rejected=await settleStorage(client,auditActor,{fileId,bucketId:source.bucket_id,objectKey:source.object_key,
                kind:"initial_upload",expectedBytes:Number(source.size_bytes),expiresAt:source.expires_at},actualSizeBytes);
            if(rejected) {
                await client.query(`update filesvc.files set status='quarantined',size_bytes=$2,content_type=$3,updated_at=now() where id=$1`,[fileId,actualSizeBytes,actualContentType]);
                await client.query(`update filesvc.upload_intents set completed_at=null where file_id=$1`,[fileId]);
                await recordAudit(auditActor,{action:"file.quarantined",outcome:"failure",resourceType:"file",resourceId:fileId,details:{reason:rejected}},client);
                await client.query("commit");
                return rejected;
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
            await client.query(
                `insert into filesvc.file_versions
                 (file_id, version_number, bucket_id, object_key, original_name, content_type,
                  size_bytes, checksum_sha256, status, created_by_kind, created_by_id, completed_at)
                 select id, 1, bucket_id, object_key, original_name, content_type, size_bytes,
                        checksum_sha256, 'available', $4, $5::uuid, now()
                 from filesvc.files where id = $1 and tenant_id = $2 and application_id = $3
                 on conflict (file_id, version_number) do nothing`,
                [fileId, tenantId, applicationId, auditActor.userId ? "user" : "api_key", auditActor.userId ?? auditActor.keyId],
            );
            await client.query(
                `update filesvc.files f set current_version_id = v.id
                 from filesvc.file_versions v
                 where f.id = $1 and f.tenant_id = $2 and f.application_id = $3
                   and v.file_id = f.id and v.version_number = 1 and f.current_version_id is null`,
                [fileId, tenantId, applicationId],
            );
            await client.query(`update filesvc.storage_allocations a set version_id=f.current_version_id,updated_at=now()
              from filesvc.files f where f.id=$1 and a.file_id=f.id and a.bucket_id=f.bucket_id and a.object_key=f.object_key
                and a.tenant_id=$2 and a.application_id=$3`,[fileId,tenantId,applicationId]);
            await recordAudit(
                auditActor,
                {
                    action: "file.upload_complete",
                    outcome: "success",
                    resourceType: "file",
                    resourceId: fileId,
                    details: { sizeBytes: actualSizeBytes, contentType: actualContentType },
                },
                client,
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

    async quarantineUpload(auditActor: AuthenticatedApplication, fileId: string, tenantId: string, applicationId: string, actualSizeBytes?:number, actualContentType?:string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("begin");
            const source=(await client.query<{bucket_id:string;object_key:string;size_bytes:string;expires_at:Date}>(
                `select f.bucket_id,f.object_key,f.size_bytes,ui.expires_at from filesvc.files f
                 join filesvc.upload_intents ui on ui.file_id=f.id where f.id=$1 and f.tenant_id=$2 and f.application_id=$3
                   and f.status='pending_upload' for update of f`,[fileId,tenantId,applicationId],
            )).rows[0];
            if(source && actualSizeBytes!==undefined) await settleStorage(client,auditActor,{fileId,bucketId:source.bucket_id,
                objectKey:source.object_key,kind:"initial_upload",expectedBytes:Number(source.size_bytes),expiresAt:source.expires_at},actualSizeBytes,true);
            const result = await client.query(
                `
        update filesvc.files
        set status = 'quarantined', size_bytes=coalesce($4::bigint,size_bytes),content_type=coalesce($5::text,content_type),updated_at = now()
        where id = $1 and tenant_id = $2 and application_id = $3
          and status = 'pending_upload'
      `,
                [fileId, tenantId, applicationId,actualSizeBytes??null,actualContentType??null],
            );
            if (result.rowCount)
                await recordAudit(
                    auditActor,
                    {
                        action: "file.quarantined",
                        outcome: "failure",
                        resourceType: "file",
                        resourceId: fileId,
                        details: { reason: "file_too_large" },
                    },
                    client,
                );
            await client.query("commit");
        } catch (error) {
            await client.query("rollback").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}
