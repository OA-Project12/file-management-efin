import { auditRoute } from "@/infrastructure/audit/audit-route";
import { listVersions } from "@/infrastructure/http/file-version-handlers";

export const GET = auditRoute("file.versions_read", "file", listVersions, { recordSuccess: false });
