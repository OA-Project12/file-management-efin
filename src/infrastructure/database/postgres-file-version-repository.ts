import "server-only";
import type { PoolClient } from "pg";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { departmentIdsForRole } from "@/application/auth/department-authorization";
import { getDatabasePool } from "./pool";
import { recordAudit } from "@/infrastructure/audit/record-audit";
import { reserveStorage, settleStorage, pendingStorageRelease } from "./storage-quota-accounting";

export class VersionError extends Error {
    constructor(
        public code: string,
        public status: number,
    ) {
        super(code);
    }
}

export type VersionScope = { app: AuthenticatedApplication; ownerSubject: string | null };
export type AvailableVersion = {
    id: string;
    file_id: string;
    version_number: number;
    bucket_id: string;
    object_key: string;
    original_name: string;
    content_type: string;
    size_bytes: string;
    checksum_sha256: string | null;
};
type FileHead = { id: string; current_version_id: string | null };
type PendingVersion = {
    id: string;
    bucket_id: string;
    object_key: string;
    content_type: string;
    size_bytes: string;
    status: string;
    expires_at: Date;
    completed_at: Date | null;
    base_version_id: string;
    version_number: number;
    original_name: string;
    checksum_sha256: string | null;
};

async function lockFile(client: PoolClient, fileId: string, scope: VersionScope, write: boolean): Promise<FileHead> {
    const { app } = scope;
    const result = await client.query<FileHead>(
        `select f.id, f.current_version_id from filesvc.files f
         where f.id=$1 and f.tenant_id=$2 and f.application_id=$3
           and f.status='available' and f.trashed_at is null
           and ($4::text is null or f.owner_subject=$4)
           and f.department_id=any($5::uuid[])
           and ($6::uuid is null or $7::boolean or
             filesvc.folder_visible(f.tenant_id,f.application_id,f.department_id,f.folder_id,$6::uuid))
         for update of f`,
        [
            fileId,
            app.tenantId,
            app.applicationId,
            scope.ownerSubject,
            departmentIdsForRole(app, write ? "editor" : "viewer"),
            app.userId ?? null,
            app.isTenantAdmin ?? false,
        ],
    );
    if (!result.rows[0]) throw new VersionError("file_not_found", 404);
    return result.rows[0];
}

async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await getDatabasePool().connect();
    try {
        await client.query("begin");
        const result = await fn(client);
        await client.query("commit");
        return result;
    } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export class PostgresFileVersionRepository {
    async list(fileId: string, scope: VersionScope, limit: number, before: number | null) {
        return transaction(async (client) => {
            const file = await lockFile(client, fileId, scope, false);
            const result = await client.query(
                `select id, version_number as "versionNumber", original_name as "originalName",
                   content_type as "contentType", size_bytes as "sizeBytes", status,
                   created_by_kind as "createdByKind", created_by_id as "createdById",
                   created_at as "createdAt", completed_at as "completedAt",
                   restored_from_version_id as "restoredFromVersionId"
                 from filesvc.file_versions where file_id=$1 and ($2::int is null or version_number<$2)
                 order by version_number desc limit $3`,
                [fileId, before, limit + 1],
            );
            const items = result.rows.slice(0, limit);
            return {
                currentVersionId: file.current_version_id,
                items,
                nextCursor: result.rows.length > limit ? String(items.at(-1)?.versionNumber) : null,
            };
        });
    }

    async findAvailable(fileId: string, versionId: string, scope: VersionScope, write = false): Promise<AvailableVersion> {
        return transaction(async (client) => {
            await lockFile(client, fileId, scope, write);
            const result = await client.query<AvailableVersion>(
                `select * from filesvc.file_versions where id=$1 and file_id=$2 and status='available'`,
                [versionId, fileId],
            );
            if (!result.rows[0]) throw new VersionError("version_not_found", 404);
            return result.rows[0];
        });
    }

    async reserveRestore(
        fileId: string,
        sourceVersionId: string,
        scope: VersionScope,
        input: {
            versionId: string;
            expectedCurrentVersionId: string;
            objectKey: string;
            sizeBytes: number;
            contentType: string;
        },
    ) {
        return transaction(async (client) => {
            const file = await lockFile(client, fileId, scope, true);
            if (!file.current_version_id || file.current_version_id !== input.expectedCurrentVersionId)
                throw new VersionError("version_conflict", 409);
            if (sourceVersionId === file.current_version_id) throw new VersionError("version_already_current", 409);
            const source = (
                await client.query<AvailableVersion>(
                    `select * from filesvc.file_versions where id=$1 and file_id=$2 and status='available'`,
                    [sourceVersionId, fileId],
                )
            ).rows[0];
            if (!source) throw new VersionError("version_not_found", 404);
            const result = await client.query<{ version_number: number }>(
                `insert into filesvc.file_versions
                 (id,file_id,version_number,bucket_id,object_key,original_name,content_type,size_bytes,
                  checksum_sha256,created_by_kind,created_by_id,restored_from_version_id)
                 select $1,$2,coalesce(max(version_number),0)+1,$3,$4,$5,$6,$7,$8,$9,$10::uuid,$11
                 from filesvc.file_versions where file_id=$2 returning version_number`,
                [
                    input.versionId,
                    fileId,
                    source.bucket_id,
                    input.objectKey,
                    source.original_name,
                    input.contentType,
                    input.sizeBytes,
                    source.checksum_sha256,
                    scope.app.userId ? "user" : "api_key",
                    scope.app.userId ?? scope.app.keyId,
                    sourceVersionId,
                ],
            );
            const intent = await client.query<{ expires_at: Date }>(
                `insert into filesvc.version_restore_intents (version_id,file_id,base_version_id) values ($1,$2,$3) returning expires_at`,
                [input.versionId, fileId, file.current_version_id],
            );
            await reserveStorage(client, scope.app, {
                fileId,
                versionId: input.versionId,
                kind: "version_restore",
                bucketId: source.bucket_id,
                objectKey: input.objectKey,
                expectedBytes: input.sizeBytes,
                expiresAt: intent.rows[0].expires_at,
            });
            await recordAudit(
                scope.app,
                {
                    action: "file.version_restore_requested",
                    outcome: "success",
                    resourceType: "file",
                    resourceId: fileId,
                    details: { versionId: input.versionId, sourceVersionId },
                },
                client,
            );
            return { versionNumber: result.rows[0].version_number, bucketId: source.bucket_id };
        });
    }

    async completeRestore(fileId: string, versionId: string, scope: VersionScope) {
        return transaction(async (client) => {
            const file = await lockFile(client, fileId, scope, true);
            const v = (
                await client.query<
                    AvailableVersion & {
                        status: string;
                        expires_at: Date;
                        base_version_id: string;
                        restored_from_version_id: string;
                    }
                >(
                    `select v.*,i.expires_at,i.base_version_id from filesvc.file_versions v
                 join filesvc.version_restore_intents i on i.version_id=v.id
                 where v.id=$1 and v.file_id=$2 for update of v,i`,
                    [versionId, fileId],
                )
            ).rows[0];
            if (!v) throw new VersionError("version_not_found", 404);
            if (v.status === "available") return null;
            if (v.status !== "pending_upload") throw new VersionError("restore_not_pending", 409);
            if (v.expires_at.getTime() <= Date.now()) throw new VersionError("restore_expired", 410);
            if (file.current_version_id !== v.base_version_id) throw new VersionError("version_conflict", 409);
            const rejected = await settleStorage(
                client,
                scope.app,
                {
                    fileId,
                    versionId,
                    kind: "version_restore",
                    bucketId: v.bucket_id,
                    objectKey: v.object_key,
                    expectedBytes: Number(v.size_bytes),
                    expiresAt: v.expires_at,
                },
                Number(v.size_bytes),
            );
            if (rejected) {
                await client.query(`update filesvc.file_versions set status='quarantined' where id=$1`, [versionId]);
                await recordAudit(
                    scope.app,
                    {
                        action: "file.version_restore",
                        outcome: "failure",
                        resourceType: "file",
                        resourceId: fileId,
                        details: { versionId, reason: rejected },
                    },
                    client,
                );
                return rejected;
            }
            await client.query(`update filesvc.file_versions set status='available',completed_at=now() where id=$1`, [versionId]);
            await client.query(`update filesvc.version_restore_intents set completed_at=now() where version_id=$1`, [versionId]);
            await client.query(
                `update filesvc.files set current_version_id=$2,bucket_id=$3,object_key=$4,
                   original_name=$5,content_type=$6,size_bytes=$7,checksum_sha256=$8,updated_at=now() where id=$1`,
                [fileId, versionId, v.bucket_id, v.object_key, v.original_name, v.content_type, v.size_bytes, v.checksum_sha256],
            );
            await recordAudit(
                scope.app,
                {
                    action: "file.version_restore",
                    outcome: "success",
                    resourceType: "file",
                    resourceId: fileId,
                    details: { versionId, sourceVersionId: v.restored_from_version_id, versionNumber: v.version_number },
                },
                client,
            );
            return null;
        });
    }

    // Only return true when a copy is proven not to be the committed current version.
    async failRestore(fileId: string, versionId: string, scope: VersionScope, reason: string): Promise<boolean> {
        return transaction(async (client) => {
            const file = (
                await client.query<FileHead>(
                    `select id,current_version_id from filesvc.files
                 where id=$1 and tenant_id=$2 and application_id=$3 for update`,
                    [fileId, scope.app.tenantId, scope.app.applicationId],
                )
            ).rows[0];
            if (!file || file.current_version_id === versionId) return false;
            const changed = await client.query(
                `update filesvc.file_versions v set status='failed' where v.id=$1 and v.file_id=$2
                 and v.status='pending_upload' and exists (
                   select 1 from filesvc.version_restore_intents i where i.version_id=v.id and i.completed_at is null
                 ) returning v.id`,
                [versionId, fileId],
            );
            if (!changed.rowCount) return false;
            await pendingStorageRelease(client, scope.app, fileId, versionId);
            await recordAudit(
                scope.app,
                {
                    action: "file.version_restore",
                    outcome: "failure",
                    resourceType: "file",
                    resourceId: fileId,
                    details: { versionId, reason },
                },
                client,
            );
            return true;
        });
    }

    async create(
        fileId: string,
        scope: VersionScope,
        input: {
            versionId: string;
            expectedCurrentVersionId: string;
            bucketId: string;
            objectKey: string;
            originalName: string;
            contentType: string;
            sizeBytes: number;
            checksumSha256: string | null;
        },
    ) {
        return transaction(async (client) => {
            const file = await lockFile(client, fileId, scope, true);
            if (!file.current_version_id || file.current_version_id !== input.expectedCurrentVersionId)
                throw new VersionError("version_conflict", 409);
            const { rows } = await client.query<{ version_number: number }>(
                `insert into filesvc.file_versions
                 (id,file_id,version_number,bucket_id,object_key,original_name,content_type,size_bytes,
                  checksum_sha256,created_by_kind,created_by_id)
                 select $1,$2,coalesce(max(version_number),0)+1,$3,$4,$5,$6,$7,$8,$9,$10::uuid
                 from filesvc.file_versions where file_id=$2 returning version_number`,
                [
                    input.versionId,
                    fileId,
                    input.bucketId,
                    input.objectKey,
                    input.originalName,
                    input.contentType,
                    input.sizeBytes,
                    input.checksumSha256,
                    scope.app.userId ? "user" : "api_key",
                    scope.app.userId ?? scope.app.keyId,
                ],
            );
            const intent = await client.query<{ expires_at: Date }>(
                `insert into filesvc.version_upload_intents (version_id,base_version_id,file_id,expires_at)
                 values ($1,$2,$3,now()+interval '2 hours') returning expires_at`,
                [input.versionId, file.current_version_id, fileId],
            );
            await reserveStorage(client, scope.app, {
                fileId,
                versionId: input.versionId,
                kind: "version_upload",
                bucketId: input.bucketId,
                objectKey: input.objectKey,
                expectedBytes: input.sizeBytes,
                expiresAt: intent.rows[0].expires_at,
            });
            await recordAudit(
                scope.app,
                {
                    action: "file.version_upload_intent",
                    outcome: "success",
                    resourceType: "file",
                    resourceId: fileId,
                    details: { versionId: input.versionId, versionNumber: rows[0].version_number },
                },
                client,
            );
            return { versionNumber: rows[0].version_number, expiresAt: intent.rows[0].expires_at };
        });
    }

    async find(fileId: string, versionId: string, scope: VersionScope): Promise<PendingVersion> {
        return transaction(async (client) => {
            await lockFile(client, fileId, scope, true);
            const result = await client.query<PendingVersion>(
                `select v.*, i.expires_at, i.completed_at, i.base_version_id
                 from filesvc.file_versions v join filesvc.version_upload_intents i on i.version_id=v.id
                 where v.id=$1 and v.file_id=$2`,
                [versionId, fileId],
            );
            if (!result.rows[0]) throw new VersionError("version_not_found", 404);
            return result.rows[0];
        });
    }

    async complete(fileId: string, versionId: string, scope: VersionScope, size: number, contentType: string, oversized: boolean) {
        return transaction(async (client) => {
            const file = await lockFile(client, fileId, scope, true);
            const result = await client.query<PendingVersion>(
                `select v.*, i.expires_at, i.completed_at, i.base_version_id
                 from filesvc.file_versions v join filesvc.version_upload_intents i on i.version_id=v.id
                 where v.id=$1 and v.file_id=$2 for update of v,i`,
                [versionId, fileId],
            );
            const v = result.rows[0];
            if (!v) throw new VersionError("version_not_found", 404);
            if (v.completed_at && v.status === "available") return null;
            if (v.status !== "pending_upload") throw new VersionError("upload_not_pending", 409);
            if (v.expires_at.getTime() <= Date.now()) throw new VersionError("upload_intent_expired", 410);
            if (file.current_version_id !== v.base_version_id) throw new VersionError("version_conflict", 409);
            const quotaRejection = await settleStorage(
                client,
                scope.app,
                {
                    fileId,
                    versionId,
                    kind: "version_upload",
                    bucketId: v.bucket_id,
                    objectKey: v.object_key,
                    expectedBytes: Number(v.size_bytes),
                    expiresAt: v.expires_at,
                },
                size,
                oversized,
            );
            const rejected = oversized ? "file_too_large" : quotaRejection;
            await client.query(
                `update filesvc.file_versions set status=$2,size_bytes=$3,content_type=$4,
                   completed_at=case when $2='available' then now() else null end where id=$1`,
                [versionId, rejected ? "quarantined" : "available", size, contentType],
            );
            if (!rejected) {
                await client.query(`update filesvc.version_upload_intents set completed_at=now() where version_id=$1`, [versionId]);
                // Maintain legacy columns for the existing search, trash and outbox paths.
                await client.query(
                    `update filesvc.files set current_version_id=$2,bucket_id=$3,object_key=$4,
                       original_name=$5,content_type=$6,size_bytes=$7,checksum_sha256=$8,updated_at=now() where id=$1`,
                    [fileId, versionId, v.bucket_id, v.object_key, v.original_name, contentType, size, v.checksum_sha256],
                );
            }
            await recordAudit(
                scope.app,
                {
                    action: rejected ? "file.version_quarantined" : "file.version_upload_complete",
                    outcome: rejected ? "failure" : "success",
                    resourceType: "file",
                    resourceId: fileId,
                    details: { versionId, versionNumber: v.version_number, sizeBytes: size, contentType },
                },
                client,
            );
            return rejected;
        });
    }
}
