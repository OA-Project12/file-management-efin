import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresApplicationKeyRepository } from "@/infrastructure/database/postgres-application-key-repository";
import { departmentIdsForRole } from "@/application/auth/department-authorization";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json(
        { error: { code, message } },
        {
            status,
            headers: { "Cache-Control": "no-store" },
        },
    );
}

async function handleDELETE(request: Request, { params }: { params: Promise<{ keyId: string }> }): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes("keys:manage")) {
            return errorResponse("forbidden", "The API key does not have keys:manage scope.", 403);
        }

        const { keyId } = await params;
        if (!UUID_PATTERN.test(keyId)) return errorResponse("invalid_key_id", "keyId must be a valid UUID.", 400);
        if (keyId === application.keyId) {
            return errorResponse("cannot_revoke_current_key", "Use a different management key to revoke this key.", 409);
        }

        const revoked = await new PostgresApplicationKeyRepository().revokeForApplication(
            application,
            application.tenantId,
            application.applicationId,
            keyId,
            departmentIdsForRole(application, "admin"),
            application.scopes.includes("departments:manage"),
        );
        if (!revoked) return errorResponse("key_not_found", "API key was not found.", 404);

        return Response.json(
            { data: { id: revoked.id, revokedAt: revoked.revokedAt?.toISOString() ?? null } },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        const databaseError = error as { code?: string; message?: string };
        console.error("Could not revoke application key", {
            code: databaseError.code,
            message: databaseError.message ?? "Unknown key revocation error",
        });
        return errorResponse("service_unavailable", "Could not revoke API key.", 503);
    }
}

export const DELETE = auditRoute("key.revoke", "api_key", handleDELETE, { recordSuccess: false, signedUrl: false });
