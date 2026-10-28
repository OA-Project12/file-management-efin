export interface CreatePendingUploadInput {
  fileId: string;
  tenantId: string;
  applicationId: string;
  departmentId: string;
  ownerSubject: string;
  bucketId: string;
  objectKey: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  tokenFingerprint: Buffer;
  expiresInSeconds: number;
}

export interface PendingUpload {
  fileId: string;
  expiresAt: Date;
}

export interface UploadRecord {
  fileId: string;
  bucketId: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  departmentId: string;
  status: string;
  expiresAt: Date;
  completedAt: Date | null;
}

export interface UploadIntentRepository {
  createPendingUpload(input: CreatePendingUploadInput): Promise<PendingUpload>;
  findUpload(
    fileId: string,
    tenantId: string,
    applicationId: string,
  ): Promise<UploadRecord | null>;
  completeUpload(
    fileId: string,
    tenantId: string,
    applicationId: string,
    departmentIds: string[],
    actualSizeBytes: number,
    actualContentType: string,
  ): Promise<boolean>;
  quarantineUpload(fileId: string, tenantId: string, applicationId: string): Promise<void>;
}
