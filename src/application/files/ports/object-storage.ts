export interface UploadGrant {
  bucket: string;
  objectKey: string;
  signedUrl: string;
  token: string;
}

export interface DownloadGrant {
  signedUrl: string;
  expiresInSeconds: number;
}

export interface StoredObjectInfo {
  sizeBytes: number;
  contentType: string | null;
}

export interface ObjectStorage {
  createUploadGrant(objectKey: string): Promise<UploadGrant>;
  createDownloadGrant(
    bucketId: string,
    objectKey: string,
    expiresInSeconds: number,
    downloadName: string,
  ): Promise<DownloadGrant>;
  getObjectInfo(bucketId: string, objectKey: string): Promise<StoredObjectInfo | null>;
  deleteObject(bucketId: string, objectKey: string): Promise<void>;
}
