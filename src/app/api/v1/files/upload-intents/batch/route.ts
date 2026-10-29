import { RequestFileUpload } from "@/application/files/request-file-upload";
import { departmentIdsForRole, hasDepartmentRole } from "@/application/auth/department-authorization";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresUploadIntentRepository } from "@/infrastructure/database/postgres-upload-intent-repository";
import { SupabaseObjectStorage } from "@/infrastructure/storage/supabase-object-storage";

const MAX_FILES = 20;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("request_too_large");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { return null; }
}

type FileInput = { originalName?: unknown; contentType?: unknown; sizeBytes?: unknown; checksumSha256?: unknown };

function validateFile(value: unknown, maxSize: number):
  | { file: { originalName: string; contentType: string; sizeBytes: number; checksumSha256: string | null } }
  | { error: { code: string; message: string } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: { code: "invalid_file", message: "Each file must be a JSON object." } };
  }
  const input = value as FileInput;
  const originalName = typeof input.originalName === "string"
    ? input.originalName.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  const contentType = typeof input.contentType === "string" ? input.contentType.trim() : "";
  if (!originalName || originalName.length > 1024) {
    return { error: { code: "invalid_file_name", message: "originalName must contain 1 to 1024 characters." } };
  }
  if (!contentType || contentType.length > 255 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)) {
    return { error: { code: "invalid_content_type", message: "contentType must be a valid media type." } };
  }
  if (typeof input.sizeBytes !== "number" || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1) {
    return { error: { code: "invalid_size", message: "sizeBytes must be a positive integer." } };
  }
  if (input.sizeBytes > maxSize) {
    return { error: { code: "file_too_large", message: "File exceeds the configured upload size limit." } };
  }
  const checksum = input.checksumSha256;
  if (checksum !== undefined && checksum !== null && (typeof checksum !== "string" || !/^[a-f0-9]{64}$/i.test(checksum))) {
    return { error: { code: "invalid_checksum", message: "checksumSha256 must be a 64-character SHA-256 hex value." } };
  }
  return { file: { originalName, contentType, sizeBytes: input.sizeBytes, checksumSha256: typeof checksum === "string" ? checksum.toLowerCase() : null } };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const application = await authenticateApplicationKey(request);
    if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
    if (!application.scopes.includes("files:write")) return errorResponse("forbidden", "files:write scope is required.", 403);

    let body: unknown;
    try { body = await readBody(request); }
    catch (error) {
      if (error instanceof RangeError) return errorResponse("request_too_large", "Request body is too large.", 413);
      throw error;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
    const input = body as { ownerSubject?: unknown; departmentId?: unknown; files?: unknown };
    const ownerSubject = typeof input.ownerSubject === "string" ? input.ownerSubject.trim() : "";
    if (!ownerSubject || ownerSubject.length > 255) return errorResponse("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
    const editableDepartments = departmentIdsForRole(application, "editor");
    const requestedDepartmentId = typeof input.departmentId === "string" ? input.departmentId : "";
    const departmentId = requestedDepartmentId || (editableDepartments.length === 1 ? editableDepartments[0] : "");
    if (!departmentId || !UUID_PATTERN.test(departmentId)) return errorResponse("invalid_department_id", "Select a departmentId for this upload.", 400);
    if (!hasDepartmentRole(application, departmentId, "editor")) return errorResponse("department_forbidden", "Editor access to this department is required.", 403);
    if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) {
      return errorResponse("invalid_files", `files must contain 1 to ${MAX_FILES} entries.`, 400);
    }

    const configured = Number(process.env.MAX_UPLOAD_SIZE_BYTES ?? DEFAULT_MAX_UPLOAD_SIZE_BYTES);
    const maxSize = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_SIZE_BYTES;
    const useCase = new RequestFileUpload(new PostgresUploadIntentRepository(), new SupabaseObjectStorage());
    const items = [];
    for (const [index, value] of input.files.entries()) {
      const result = validateFile(value, maxSize);
      if ("error" in result) {
        items.push({ index, status: "error", error: result.error });
        continue;
      }
      try {
        const upload = await useCase.execute({
          tenantId: application.tenantId, applicationId: application.applicationId,
          departmentId, ownerSubject, ...result.file,
        });
        items.push({ index, status: "ready", ...upload });
      } catch (error) {
        console.error("Could not create batch upload intent", { index, message: error instanceof Error ? error.message : "Unknown error" });
        items.push({ index, status: "error", error: { code: "service_unavailable", message: "Could not create an upload intent for this file." } });
      }
    }
    const readyCount = items.filter((item) => item.status === "ready").length;
    return Response.json({ data: { items, readyCount, errorCount: items.length - readyCount } }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not create batch upload intents", { message: error instanceof Error ? error.message : "Unknown error" });
    return errorResponse("service_unavailable", "Could not create batch upload intents.", 503);
  }
}
