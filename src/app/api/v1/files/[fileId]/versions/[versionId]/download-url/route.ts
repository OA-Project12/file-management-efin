import { auditRoute } from "@/infrastructure/audit/audit-route";
import { downloadVersion } from "@/infrastructure/http/file-version-handlers";

export const POST = auditRoute("file.version_download_url", "file", downloadVersion, { recordSuccess: false });
