import { auditRoute } from "@/infrastructure/audit/audit-route";
import { previewVersion } from "@/infrastructure/http/file-version-handlers";

export const POST = auditRoute("file.version_preview_url", "file", previewVersion, { recordSuccess: false });
