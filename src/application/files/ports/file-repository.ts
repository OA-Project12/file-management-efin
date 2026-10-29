import type { FileRecord } from "@/domain/files/file-record";

export interface FileScope {
    tenantId: string;
    applicationId: string;
    ownerSubject: string | null;
    departmentIds: string[];
    userId?: string;
    isTenantAdmin?: boolean;
}

export interface FilePagePosition {
    createdAt: Date;
    fileId: string;
}

export interface TrashPagePosition {
    trashedAt: string;
    fileId: string;
}

export interface TrashedObject {
    bucketId: string;
    objectKey: string;
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
    trashedAt?: Date;
    trashedAtCursor?: string;
}

export interface FileSearchFilters {
    folderId?: string;
    departmentId?: string;
    tag?: string;
    contentType?: string;
    createdFrom?: string;
    createdBefore?: string;
}

export type FileDeletionRequestResult = "trashed" | "already_deleted" | "not_found" | "not_deletable";

export interface FileRepository {
    findAvailableById(fileId: string, scope: FileScope): Promise<FileRecord | null>;
    listAvailable(scope: FileScope, limit: number, before?: FilePagePosition, filters?: FileSearchFilters): Promise<FileListItem[]>;
    requestDelete(fileId: string, scope: FileScope): Promise<FileDeletionRequestResult>;
    listTrash(scope: FileScope, limit: number, before?: TrashPagePosition, departmentId?: string): Promise<FileListItem[]>;
    findTrashedObject(fileId: string, scope: FileScope): Promise<TrashedObject | null>;
    restore(fileId: string, scope: FileScope): Promise<"restored" | "not_found">;
    requestPurge(fileId: string, scope: FileScope): Promise<"queued" | "not_found">;
}
