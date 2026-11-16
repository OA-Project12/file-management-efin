import { logger } from "@/infrastructure/security/logger.mjs";
import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresApplicationKeyRepository, type KeyDepartmentChange } from "@/infrastructure/database/postgres-application-key-repository";
import { parseKeyName, presentApplicationKey } from "@/infrastructure/http/application-keys";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(code: string, message: string, status: number, details?: { revision: number }): Response {
    return Response.json(
        { error: { code, message, ...(details && { details }) } },
        {
            status,
            headers: { "Cache-Control": "no-store" },
        },
    );
}

function parseDepartmentChanges(value: unknown): KeyDepartmentChange[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > 100) return null;
    const grants = new Map<string, KeyDepartmentChange>();
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 2) return null;
        const { departmentId, role } = entry as Record<string, unknown>;
        if (typeof departmentId !== "string" || !UUID_PATTERN.test(departmentId) ||
            (role !== "viewer" && role !== "editor" && role !== "admin")) return null;
        const id = departmentId.toLowerCase();
        if (grants.has(id)) return null;
        grants.set(id, { departmentId: id, role });
    }
    return [...grants.values()];
}

async function handlePATCH(request: Request, { params }: { params: Promise<{ keyId: string }> }): Promise<Response> {
    try {
        const actor = await authenticateApplicationKey(request);
        if (!actor) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (actor.userId || !actor.scopes.includes("keys:manage")) {
            return errorResponse("forbidden", "A management API key is required.", 403);
        }
        const { keyId } = await params;
        if (!UUID_PATTERN.test(keyId)) return errorResponse("invalid_key_id", "keyId must be a valid UUID.", 400);

        const value: unknown = await request.json().catch(() => null);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
        }
        const { expectedRevision, name, departmentGrants } = value as Record<string, unknown>;
        if (Object.keys(value).some((field) => !["expectedRevision", "name", "departmentGrants"].includes(field)) ||
            (name === undefined && departmentGrants === undefined)) {
            return errorResponse("invalid_key_update", "Send name and/or departmentGrants with expectedRevision.", 400);
        }
        if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 2147483647) {
            return errorResponse("invalid_revision", "expectedRevision must be a non-negative integer.", 400);
        }
        const parsedName = parseKeyName(name);
        if (name !== undefined && parsedName === undefined) {
            return errorResponse("invalid_key_name", "Use a name of 1 to 100 characters without credentials, or null.", 400);
        }
        const parsedGrants = departmentGrants === undefined ? undefined : parseDepartmentChanges(departmentGrants);
        if (parsedGrants === null) {
            return errorResponse("invalid_department_grants", "Send 1 to 100 unique department IDs with valid roles.", 400);
        }

        const result = await new PostgresApplicationKeyRepository().updateForApplication({
            actor, keyId, expectedRevision, name: parsedName, departmentGrants: parsedGrants,
        });
        switch (result.status) {
            case "unauthorized": return errorResponse("unauthorized", "A valid API key is required.", 401);
            case "forbidden": return errorResponse("forbidden", "A management API key is required.", 403);
            case "not_found": return errorResponse("key_not_found", "API key was not found.", 404);
            case "department_forbidden": return errorResponse("department_grant_forbidden", "Admin access is required for every requested active department.", 403);
            case "not_editable": return errorResponse("key_not_editable", "Only active file API keys can be updated.", 409);
            case "rotation_in_progress": return errorResponse("key_rotation_overlap", "Update roles on the latest key after the earlier keys expire or are revoked.", 409);
            case "revision_conflict": return errorResponse("key_revision_conflict", "Reload the key before updating it again.", 409, { revision: result.revision });
            case "updated": return Response.json({ data: presentApplicationKey(result.key) }, { headers: { "Cache-Control": "no-store" } });
        }
    } catch (error) {
        logger.error("Could not update application key", { code: (error as { code?: string }).code });
        return errorResponse("service_unavailable", "Could not update API key.", 503);
    }
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
        if (keyId.toLowerCase() === application.keyId) {
            return errorResponse("cannot_revoke_current_key", "Use a different management key to revoke this key.", 409);
        }

        const revoked = await new PostgresApplicationKeyRepository().revokeForApplication(application, keyId);
        if (!revoked) return errorResponse("key_not_found", "API key was not found.", 404);

        return Response.json(
            { data: { id: revoked.id, revokedAt: revoked.revokedAt?.toISOString() ?? null } },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        const databaseError = error as { code?: string; message?: string };
        logger.error("Could not revoke application key", {
            code: databaseError.code,
            message: databaseError.message ?? "Unknown key revocation error",
        });
        return errorResponse("service_unavailable", "Could not revoke API key.", 503);
    }
}

export const DELETE = auditRoute("key.revoke", "api_key", handleDELETE, { recordSuccess: false, signedUrl: false });
export const PATCH = auditRoute("key.update", "api_key", handlePATCH, { recordSuccess: false, signedUrl: false });
