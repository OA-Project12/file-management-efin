import { logger } from "@/infrastructure/security/logger.mjs";
import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { ManageDepartmentQuotas } from "@/application/storage/manage-department-quotas";
import { PostgresDepartmentQuotaRepository } from "@/infrastructure/database/postgres-department-quota-repository";
import { storageQuotaErrorResponse } from "@/infrastructure/http/storage-quota-errors";

async function handleGET(request: Request): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app)
            return Response.json(
                { error: { code: "unauthorized", message: "A valid session or API key is required." } },
                { status: 401, headers: { "Cache-Control": "no-store" } },
            );
        const data = await new ManageDepartmentQuotas(new PostgresDepartmentQuotaRepository()).list(app);
        return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        const response = storageQuotaErrorResponse(error);
        if (response) return response;
        logger.error("Could not list storage quotas");
        return Response.json(
            { error: { code: "service_unavailable", message: "Could not list storage quotas." } },
            { status: 503, headers: { "Cache-Control": "no-store" } },
        );
    }
}
export const GET = auditRoute("department.storage_read", "department", handleGET, { recordSuccess: false });
