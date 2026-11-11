import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresApplicationKeyRepository } from "@/infrastructure/database/postgres-application-key-repository";
import { generateApplicationKey, parseKeyExpiryDays, presentApplicationKey } from "@/infrastructure/http/application-keys";
import { logger } from "@/infrastructure/security/logger.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" };

function fail(status: number, code: string, message: string, details?: { replacementId: string }) {
    return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status, headers: noStore });
}

async function handlePOST(request: Request, { params }: { params: Promise<{ keyId: string }> }): Promise<Response> {
    try {
        const actor = await authenticateApplicationKey(request);
        if (!actor) return fail(401, "unauthorized", "A valid management API key is required.");
        if (actor.userId || !actor.scopes.includes("keys:manage"))
            return fail(403, "forbidden", "The API key does not have keys:manage scope.");

        const { keyId } = await params;
        if (!UUID.test(keyId)) return fail(400, "invalid_key_id", "keyId must be a valid UUID.");

        // The security route has already validated and bounded the original JSON stream.
        const text = await request.text();
        const body: unknown = text ? JSON.parse(text) : {};
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "expiresInDays"))
            return fail(400, "invalid_rotation_request", "Only expiresInDays may be provided.");
        const expiresInDays = parseKeyExpiryDays("expiresInDays" in body ? body.expiresInDays : undefined);
        if (expiresInDays === null) return fail(400, "invalid_expiry", "expiresInDays must be an integer from 1 to 365.");

        const { keyPrefix, secretHash, apiKey } = generateApplicationKey();
        const id = keyId.toLowerCase();
        const result = await new PostgresApplicationKeyRepository().rotateForApplication({
            actor,
            keyId: id,
            keyPrefix,
            secretHash,
            expiresInDays,
        });
        switch (result.status) {
            case "unauthorized":
                return fail(401, "unauthorized", "The management API key is no longer active.");
            case "forbidden":
                return fail(403, "forbidden", "The API key does not have keys:manage scope.");
            case "not_found":
                return fail(404, "key_not_found", "API key was not found.");
            case "not_rotatable":
                return fail(409, "key_not_rotatable", "Only active file API keys with department grants can be rotated.");
            case "already_rotated":
                return fail(409, "key_already_rotated", "This API key already has a replacement.", {
                    replacementId: result.replacementId,
                });
            case "rotated":
                return Response.json(
                    {
                        data: {
                            ...presentApplicationKey(result.key),
                            apiKey,
                            oldKey: { id, expiresAt: result.oldExpiresAt.toISOString() },
                            warning: "Copy this key now. Its secret cannot be retrieved again.",
                        },
                    },
                    { status: 201, headers: { ...noStore, Pragma: "no-cache" } },
                );
        }
    } catch (error) {
        logger.error("Could not rotate application key", { code: (error as { code?: string }).code });
        return fail(503, "service_unavailable", "Could not rotate API key.");
    }
}

export const POST = auditRoute("key.rotate", "api_key", handlePOST, { recordSuccess: false, signedUrl: false });
