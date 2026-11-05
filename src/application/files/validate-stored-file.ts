import type { ObjectStorage, StoredObjectInfo } from "./ports/object-storage";
import { FileValidationError, validateFilePrefix } from "@/domain/files/file-validation";

export async function validateStoredFile(storage: ObjectStorage, bucket: string, key: string, name: string, declaredMime: string, before: StoredObjectInfo) {
    try {
        const prefix = await storage.readObjectPrefix(bucket, key, before);
        const after = await storage.getObjectInfo(bucket, key);
        if (!after || before.sizeBytes !== after.sizeBytes || before.contentType !== after.contentType ||
            before.version !== after.version || before.eTag !== after.eTag || before.lastModified !== after.lastModified)
            throw new FileValidationError("object_changed");
        if (prefix.length !== Math.min(1024, before.sizeBytes)) throw new FileValidationError("file_validation_unavailable");
        return validateFilePrefix(name, declaredMime, after.contentType, prefix);
    } catch (error) {
        if (error instanceof FileValidationError) throw error;
        throw new FileValidationError("file_validation_unavailable");
    }
}

export async function validationObjectInfo(storage: ObjectStorage, bucket: string, key: string) {
    try { return await storage.getObjectInfo(bucket, key); }
    catch { throw new FileValidationError("file_validation_unavailable"); }
}
