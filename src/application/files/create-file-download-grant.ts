import "server-only";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import type { ObjectStorage } from "@/application/files/ports/object-storage";
import type { FileRepository } from "@/application/files/ports/file-repository";

const DOWNLOAD_URL_TTL_SECONDS = 300;

export interface CreateFileDownloadGrantInput {
    fileId: string;
    ownerSubject: string | null;
    application: AuthenticatedApplication;
}

export class CreateFileDownloadGrant {
    constructor(
        private readonly fileRepository: FileRepository,
        private readonly objectStorage: ObjectStorage,
    ) {}

    async execute(input: CreateFileDownloadGrantInput) {
        const file = await this.fileRepository.findAvailableById(input.fileId, {
            tenantId: input.application.tenantId,
            applicationId: input.application.applicationId,
            ownerSubject: input.ownerSubject,
            departmentIds: input.application.departments.map((department) => department.id),
            userId: input.application.userId,
            isTenantAdmin: input.application.isTenantAdmin,
        });

        if (!file) return null;

        const grant = await this.objectStorage.createDownloadGrant(
            file.bucketId,
            file.objectKey,
            DOWNLOAD_URL_TTL_SECONDS,
            file.originalName,
        );

        return {
            fileId: file.id,
            fileName: file.originalName,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            signedUrl: grant.signedUrl,
            expiresInSeconds: grant.expiresInSeconds,
        };
    }
}
