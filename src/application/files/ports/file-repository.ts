import type { FileRecord } from "@/domain/files/file-record";

export interface FileScope {
  tenantId: string;
  applicationId: string;
  ownerSubject: string;
  departmentIds: string[];
}

export interface FilePagePosition {
  createdAt: Date;
  fileId: string;
}

export interface FileListItem {
  id: string;
  originalName: string;
  displayName: string;
  contentType: string;
  sizeBytes: string;
  folderId: string | null;
  departmentId: string;
  department: string | null;
  tags: string[];
  createdAt: Date;
}

export interface FileSearchFilters {
  folderId?: string;
  departmentId?: string;
  tag?: string;
  contentType?: string;
  createdFrom?: string;
  createdBefore?: string;
}

export type FileDeletionRequestResult =
  | "queued"
  | "already_deleting"
  | "already_deleted"
  | "not_found"
  | "not_deletable";

export interface FileRepository {
  findAvailableById(fileId: string, scope: FileScope): Promise<FileRecord | null>;
  listAvailable(
    scope: FileScope,
    limit: number,
    before?: FilePagePosition,
    filters?: FileSearchFilters,
  ): Promise<FileListItem[]>;
  requestDelete(fileId: string, scope: FileScope): Promise<FileDeletionRequestResult>;
}
