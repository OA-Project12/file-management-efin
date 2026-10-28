import { createClient } from "@supabase/supabase-js";

const bucketId = process.env.STORAGE_BUCKET ?? "private-files";
const fileSizeLimit = Number(process.env.MAX_UPLOAD_SIZE_BYTES ?? "26214400");
const supabaseUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !secretKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be configured.");
}

if (!Number.isSafeInteger(fileSizeLimit) || fileSizeLimit <= 0) {
  throw new Error("MAX_UPLOAD_SIZE_BYTES must be a positive safe integer.");
}

const supabase = createClient(supabaseUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: existingBucket, error: getError } = await supabase.storage.getBucket(bucketId);
if (getError) throw new Error(`Could not read storage bucket: ${getError.message}`);
if (!existingBucket) throw new Error(`Storage bucket '${bucketId}' does not exist.`);

if (existingBucket.public) {
  throw new Error(`Refusing to change public bucket '${bucketId}'.`);
}

const { error: updateError } = await supabase.storage.updateBucket(bucketId, {
  public: false,
  fileSizeLimit,
});
if (updateError) throw new Error(`Could not update storage bucket: ${updateError.message}`);

const { data: bucket, error: verifyError } = await supabase.storage.getBucket(bucketId);
if (verifyError) throw new Error(`Could not verify storage bucket: ${verifyError.message}`);
if (!bucket) throw new Error(`Storage bucket '${bucketId}' was not returned after update.`);

console.log(
  JSON.stringify(
    {
      id: bucket.id,
      public: bucket.public,
      fileSizeLimitBytes: bucket.file_size_limit ?? null,
      allowedMimeTypes: bucket.allowed_mime_types ?? null,
    },
    null,
    2,
  ),
);

if (bucket.public || bucket.file_size_limit !== fileSizeLimit) {
  throw new Error("Storage bucket verification did not match the requested settings.");
}
