import { RequestFileUpload } from "@/application/files/request-file-upload";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { SupabaseObjectStorage } from "@/infrastructure/storage/supabase-object-storage";
import { PostgresUploadIntentRepository } from "@/infrastructure/database/postgres-upload-intent-repository";
import { departmentIdsForRole, hasDepartmentRole } from "@/application/auth/department-authorization";

const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BODY_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface UploadIntentRequest {
  ownerSubject?: unknown;
  departmentId?: unknown;
  originalName?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
  checksumSha256?: unknown;
}

function getMaxUploadSizeBytes(): number {
  const configured = Number(process.env.MAX_UPLOAD_SIZE_BYTES ?? DEFAULT_MAX_UPLOAD_SIZE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_UPLOAD_SIZE_BYTES;
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function readJsonBody(request: Request): Promise<UploadIntentRequest | null> {
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_METADATA_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError("metadata_body_too_large");
    }
    chunks.push(value);
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as UploadIntentRequest;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const application = await authenticateApplicationKey(request);
    if (!application) {
      return errorResponse("unauthorized", "A valid API key is required.", 401);
    }
    if (!application.scopes.includes("files:write")) {
      return errorResponse("forbidden", "The API key does not have files:write scope.", 403);
    }

    let body: UploadIntentRequest;
    try {
      const parsed = await readJsonBody(request);
      if (!parsed) throw new Error("invalid_json");
      body = parsed;
    } catch (error) {
      if (error instanceof RangeError) {
        return errorResponse("request_too_large", "Upload metadata request is too large.", 413);
      }
      return errorResponse("invalid_json", "Request body must be valid JSON.", 400);
    }

    const ownerSubject = typeof body.ownerSubject === "string" ? body.ownerSubject.trim() : "";
    const editableDepartments = departmentIdsForRole(application, "editor");
    const requestedDepartmentId = typeof body.departmentId === "string" ? body.departmentId : "";
    const departmentId = requestedDepartmentId || (editableDepartments.length === 1 ? editableDepartments[0] : "");
    if (!departmentId || !UUID_PATTERN.test(departmentId)) {
      return errorResponse("invalid_department_id", "Select a departmentId for this upload.", 400);
    }
    if (!hasDepartmentRole(application, departmentId, "editor")) {
      return errorResponse("department_forbidden", "Editor access to this department is required.", 403);
    }
    const originalName = typeof body.originalName === "string"
      ? body.originalName.replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim()
      : "";
    const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "";
    const sizeBytes = body.sizeBytes;
    const checksumSha256 = body.checksumSha256 === undefined || body.checksumSha256 === null
      ? null
      : typeof body.checksumSha256 === "string" && /^[a-f0-9]{64}$/i.test(body.checksumSha256)
        ? body.checksumSha256.toLowerCase()
        : undefined;

    if (!ownerSubject || ownerSubject.length > 255) {
      return errorResponse("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
    }
    if (!originalName || originalName.length > 1024) {
      return errorResponse("invalid_file_name", "originalName must contain 1 to 1024 characters.", 400);
    }
    if (!contentType || contentType.length > 255 || !/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(contentType)) {
      return errorResponse("invalid_content_type", "contentType must be a valid media type.", 400);
    }
    if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      return errorResponse("invalid_size", "sizeBytes must be a positive integer.", 400);
    }
    if (sizeBytes > getMaxUploadSizeBytes()) {
      return errorResponse("file_too_large", "File exceeds the configured upload size limit.", 413);
    }
    if (checksumSha256 === undefined) {
      return errorResponse("invalid_checksum", "checksumSha256 must be a 64-character SHA-256 hex value.", 400);
    }

    const useCase = new RequestFileUpload(
      new PostgresUploadIntentRepository(),
      new SupabaseObjectStorage(),
    );
    const upload = await useCase.execute({
      tenantId: application.tenantId,
      applicationId: application.applicationId,
      departmentId,
      ownerSubject,
      originalName,
      contentType,
      sizeBytes,
      checksumSha256,
    });

    return Response.json(
      { data: upload },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const serviceError = error as { code?: string; message?: string };
    console.error("Could not create upload intent", {
      code: serviceError.code,
      message: serviceError.message ?? "Unknown upload intent error",
    });

    return errorResponse("service_unavailable", "Could not create an upload intent.", 503);
  }
}
