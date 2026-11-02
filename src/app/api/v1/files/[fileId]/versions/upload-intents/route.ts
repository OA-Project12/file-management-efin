import { auditRoute } from "@/infrastructure/audit/audit-route";
import { createVersionUpload } from "@/infrastructure/http/file-version-handlers";

export const POST = auditRoute("file.version_upload_intent", "file", createVersionUpload, { recordSuccess: false });
