import { createHash } from "node:crypto";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { scanError } from "./clamd-client.mjs";
import { isMissingStorageObject, removeStoredObjectIfPresent } from "./worker-storage.mjs";

export function scanStorage(supabase, origin, secret) {
    const base = new URL(origin);
    const get = base.protocol === "https:" ? httpsGet : httpGet;
    async function info(bucket, key) {
        const {data,error} = await supabase.storage.from(bucket).info(key);
        if (isMissingStorageObject(error)) return null;
        if (error || !data || !Number.isSafeInteger(data.size)) throw scanError("storage_unavailable");
        return {sizeBytes:data.size,contentType:data.contentType??null,eTag:data.etag,version:data.version,lastModified:data.lastModified??data.updatedAt};
    }
    async function open(bucket, key, expected, signal) {
        const parts = [bucket,...key.split("/")];
        if (parts.some((part) => !part || part === "." || part === "..")) throw scanError("invalid_scan_object",true);
        const path = parts.map(encodeURIComponent).join("/");
        const url = new URL(`/storage/v1/object/authenticated/${path}`,base.origin);
        // Use a Node stream for the backpressured transfer to ClamAV (nodejs/undici#5360).
        const response = await new Promise((resolve, reject) => {
            const request = get(url, { signal, headers: {
                apikey: secret, Authorization: `Bearer ${secret}`, "Cache-Control": "no-store",
                "Accept-Encoding": "identity", ...(expected.eTag ? { "If-Match": expected.eTag } : {}),
            } }, (message) => {
                message.on("error", reject);
                resolve(message);
            });
            request.once("error", reject);
        });
        const etag = response.headers.etag;
        if (response.statusCode === 412 || (etag && expected.eTag && etag !== expected.eTag)) {
            response.destroy();
            throw scanError("object_changed",true);
        }
        if (response.statusCode !== 200) {
            response.destroy();
            throw scanError("storage_unavailable");
        }
        return response;
    }
    return {
        info,open,
        async copy(bucket,source,destination) {
            const {error} = await supabase.storage.from(bucket).copy(source,destination);
            if (error) throw scanError("copy_unavailable");
        },
        async remove(bucket,key) {
            await removeStoredObjectIfPresent(supabase,bucket,key);
            if (await info(bucket,key)) throw scanError("cleanup_not_confirmed");
        },
    };
}

export function assertObject(actual, expected) {
    if (!actual || ["sizeBytes","contentType","eTag","version","lastModified"].some((key) =>
        (actual[key]??null) !== (expected[key]??null))) throw scanError("object_changed",true);
}

export async function verifyCopy(storage, bucket, key, expected, sha256, signal) {
    if (!expected) throw scanError("copy_unavailable");
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = await storage.open(bucket,key,expected,signal);
    for await (const chunk of stream) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > expected.sizeBytes) throw scanError("copy_changed",true);
        hash.update(chunk);
    }
    if (bytes !== expected.sizeBytes || hash.digest("hex") !== sha256) throw scanError("copy_changed",true);
    assertObject(await storage.info(bucket,key),expected);
}
