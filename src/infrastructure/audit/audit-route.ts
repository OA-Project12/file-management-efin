import "server-only";
import { randomUUID } from "node:crypto";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { auditRequestContext, recordAudit, recordUnidentifiedDenial } from "@/infrastructure/audit/record-audit";

const UUID_IN_PATH = /\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i;

export function auditRoute<Args extends unknown[]>(
    action: string,
    resourceType: string,
    handler: (request: Request, ...args: Args) => Promise<Response>,
    options: { signedUrl?: boolean; recordSuccess?: boolean } = {},
): (request: Request, ...args: Args) => Promise<Response> {
    return async (request, ...args) => {
        const requestId = randomUUID();
        const before = options.recordSuccess !== false ? await authenticateApplicationKey(request).catch(() => null) : null;
        const response = await auditRequestContext.run(requestId, () => handler(request, ...args));
        const denied = [401, 403, 404].includes(response.status);
        const success = response.status >= 200 && response.status < 300;
        const failure = response.status >= 500;
        if (!denied && !failure && !(success && options.recordSuccess !== false)) return response;
        const route = new URL(request.url).pathname;
        try {
            const app = before ?? (await authenticateApplicationKey(request));
            if (!app) {
                if (denied) await recordUnidentifiedDenial(action, route, response.status, requestId);
                if (success && options.signedUrl)
                    return Response.json(
                        { error: { code: "audit_unavailable", message: "Could not record access." } },
                        { status: 503, headers: { "Cache-Control": "no-store" } },
                    );
                return response;
            }
            let resourceId: string | null = UUID_IN_PATH.exec(route)?.[1] ?? null;
            if (!resourceId && success) {
                const body = (await response
                    .clone()
                    .json()
                    .catch(() => null)) as { data?: { fileId?: string; id?: string } } | null;
                resourceId = body?.data?.fileId ?? body?.data?.id ?? null;
            }
            await recordAudit(app, {
                action,
                outcome: success ? "success" : denied ? "denied" : "failure",
                resourceType,
                resourceId,
                requestId,
                details: success ? {} : { status: response.status },
            });
        } catch (error) {
            console.error("Audit recording failed", { action, route, message: error instanceof Error ? error.message : "Unknown error" });
            if (success && options.signedUrl)
                return Response.json(
                    { error: { code: "audit_unavailable", message: "Could not record access." } },
                    { status: 503, headers: { "Cache-Control": "no-store" } },
                );
        }
        return response;
    };
}
