// Use the Storage API, never DELETE storage.objects directly: the API removes bytes too.
export function isMissingStorageObject(error) {
    return (
        Boolean(error) &&
        (Number(error.status) === 404 || Number(error.statusCode) === 404 || error.code === "NoSuchKey" || error.code === "not_found")
    );
}

export async function removeStoredObjectIfPresent(storage, bucketId, objectKey) {
    const { data, error } = await storage.storage.from(bucketId).info(objectKey);
    if (error) {
        if (isMissingStorageObject(error)) return;
        throw Object.assign(new Error("Could not inspect Storage object"), { code: `storage_${Number(error.status) || "unavailable"}` });
    }
    if (!data) return;
    const removed = await storage.storage.from(bucketId).remove([objectKey]);
    if (removed.error && !isMissingStorageObject(removed.error))
        throw Object.assign(new Error("Could not remove Storage object"), {
            code: `storage_${Number(removed.error.status) || "unavailable"}`,
        });
}
