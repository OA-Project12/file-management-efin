export type FileStatus =
  | "pending_upload"
  | "available"
  | "quarantined"
  | "deleting"
  | "deleted"
  | "failed";

export interface FileRecord {
  id: string;
  tenantId: string;
  applicationId: string;
  ownerSubject: string;
  bucketId: string;
  objectKey: string;
  originalName: string;
  contentType: string;
  sizeBytes: string;
  status: FileStatus;
  createdAt: Date;
}
