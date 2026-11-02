import { auditRoute } from "@/infrastructure/audit/audit-route";
import { completeVersionUpload } from "@/infrastructure/http/file-version-handlers";

export const POST = auditRoute("file.version_upload_complete", "file", completeVersionUpload, { recordSuccess: false });
