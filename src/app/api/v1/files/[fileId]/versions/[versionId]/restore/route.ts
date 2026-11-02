import { auditRoute } from "@/infrastructure/audit/audit-route";
import { restoreVersion } from "@/infrastructure/http/file-version-handlers";

export const POST = auditRoute("file.version_restore", "file", restoreVersion, { recordSuccess: false });
