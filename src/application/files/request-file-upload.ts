import "server-only";
import { validateDeclaredType } from "@/domain/files/file-validation";
import { createHash, randomUUID } from "node:crypto";
import type { ObjectStorage } from "@/application/files/ports/object-storage";
import type { UploadIntentRepository } from "@/application/files/ports/upload-intent-repository";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";

const SIGNED_UPLOAD_TTL_SECONDS = 2 * 60 * 60;

export interface RequestFileUploadInput {
    auditActor: AuthenticatedApplication;
    tenantId: string;
    applicationId: string;
    departmentId: string;
    folderId?: string | null;
    ownerSubject: string;
    originalName: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string | null;
}

export class RequestFileUpload {
    constructor(
        private readonly repository: UploadIntentRepository,
        private readonly storage: ObjectStorage,
    ) {}

    async execute(input: RequestFileUploadInput) {
        input = { ...input, contentType: validateDeclaredType(input.originalName, input.contentType) };
        const fileId = randomUUID();
        const objectKey = `${input.tenantId}/${input.applicationId}/${fileId}`;
        const grant = await this.storage.createUploadGrant(objectKey);
        const tokenFingerprint = createHash("sha256").update(grant.token, "utf8").digest();

        const pendingUpload = await this.repository.createPendingUpload({
            ...input,
            fileId,
            bucketId: grant.bucket,
            objectKey,
            tokenFingerprint,
            expiresInSeconds: SIGNED_UPLOAD_TTL_SECONDS,
        });

        return {
            fileId,
            bucketId: grant.bucket,
            objectKey,
            signedUrl: grant.signedUrl,
            uploadToken: grant.token,
            expiresAt: pendingUpload.expiresAt,
        };
    }
}
