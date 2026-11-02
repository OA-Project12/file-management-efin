import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DownloadGrant, ObjectStorage, StoredObjectInfo, UploadGrant } from "@/application/files/ports/object-storage";

let client: SupabaseClient | undefined;

function getStorageClient(): SupabaseClient {
    if (client) return client;

    const supabaseUrl = process.env.SUPABASE_URL;
    const secretKey = process.env.SUPABASE_SECRET_KEY;
    if (!supabaseUrl || !secretKey) {
        throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be configured.");
    }

    client = createClient(supabaseUrl, secretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
}

function getBucketName(): string {
    const bucket = process.env.STORAGE_BUCKET;
    if (!bucket) throw new Error("STORAGE_BUCKET is not configured.");
    return bucket;
}

export class SupabaseObjectStorage implements ObjectStorage {
    async copyObject(bucketId: string, sourceKey: string, destinationKey: string): Promise<void> {
        const url = process.env.SUPABASE_URL;
        const secret = process.env.SUPABASE_SECRET_KEY;
        if (!url || !secret) throw new Error("Supabase Storage is not configured.");
        // Bound the copy request well below the ten-minute restore lease used by purge.
        const deadline = AbortSignal.timeout(60_000);
        const copyClient = createClient(url,secret,{
            auth:{persistSession:false,autoRefreshToken:false},
            global:{fetch:(input,init) => fetch(input,{
                ...init,signal:AbortSignal.any([deadline,...(init?.signal ? [init.signal] : [])]),
            })},
        });
        const { error } = await copyClient.storage.from(bucketId).copy(sourceKey,destinationKey);
        if (error) throw new Error(`Could not copy file version: ${error.message}`);
    }

    async createPreviewGrant(bucketId: string, objectKey: string, expiresInSeconds: number) {
        const { data, error } = await getStorageClient().storage.from(bucketId).createSignedUrl(objectKey, expiresInSeconds);

        if (error) throw new Error(`Could not create preview grant: ${error.message}`);
        return { signedUrl: data.signedUrl, expiresInSeconds };
    }

    async createUploadGrant(objectKey: string): Promise<UploadGrant> {
        const bucket = getBucketName();
        const { data, error } = await getStorageClient().storage.from(bucket).createSignedUploadUrl(objectKey, { upsert: false });

        if (error) throw new Error(`Could not create upload grant: ${error.message}`);
        return { bucket, objectKey, signedUrl: data.signedUrl, token: data.token };
    }

    async createDownloadGrant(bucketId: string, objectKey: string, expiresInSeconds: number, downloadName: string): Promise<DownloadGrant> {
        const { data, error } = await getStorageClient()
            .storage.from(bucketId)
            .createSignedUrl(objectKey, expiresInSeconds, { download: downloadName });

        if (error) throw new Error(`Could not create download grant: ${error.message}`);
        return { signedUrl: data.signedUrl, expiresInSeconds };
    }

    async getObjectInfo(bucketId: string, objectKey: string): Promise<StoredObjectInfo | null> {
        const { data, error } = await getStorageClient().storage.from(bucketId).info(objectKey);

        if (error) {
            if (error.status === 404) return null;
            throw new Error(`Could not read uploaded object metadata: ${error.message}`);
        }

        if (typeof data.size !== "number" || !Number.isSafeInteger(data.size)) {
            throw new Error("Storage returned invalid object size metadata.");
        }

        return {
            sizeBytes: data.size,
            contentType: data.contentType ?? null,
        };
    }

    async deleteObject(bucketId: string, objectKey: string): Promise<void> {
        const { error } = await getStorageClient().storage.from(bucketId).remove([objectKey]);

        if (error) throw new Error(`Could not delete object: ${error.message}`);
    }
}
