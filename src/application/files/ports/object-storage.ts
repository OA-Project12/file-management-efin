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
  version?: string;
  eTag?: string;
  lastModified?: string;
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
  readObjectPrefix(bucketId: string, objectKey: string, expected?: StoredObjectInfo): Promise<Uint8Array>;
}
