import { logger } from "@/infrastructure/security/logger.mjs";
import { auditRoute } from "@/infrastructure/audit/audit-route";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { PostgresApplicationKeyRepository } from "@/infrastructure/database/postgres-application-key-repository";
import { canDelegateDepartmentRole, departmentIdsForRole } from "@/application/auth/department-authorization";
import { generateApplicationKey, parseKeyExpiryDays, parseKeyName, presentApplicationKey } from "@/infrastructure/http/application-keys";

const MANAGE_SCOPE = "keys:manage";
const CREATABLE_SCOPES = new Set(["files:read", "files:write", "keys:manage"]);

interface CreateKeyRequest {
    name?: unknown;
    expiresInDays?: unknown;
    scopes?: unknown;
    departmentGrants?: unknown;
}

function errorResponse(code: string, message: string, status: number): Response {
    return Response.json(
        { error: { code, message } },
        {
            status,
            headers: { "Cache-Control": "no-store" },
        },
    );
}

async function handleGET(request: Request): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes(MANAGE_SCOPE)) {
            return errorResponse("forbidden", "The API key does not have keys:manage scope.", 403);
        }

        const keys = await new PostgresApplicationKeyRepository().listForApplication(
            application.tenantId,
            application.applicationId,
            departmentIdsForRole(application, "admin"),
            application.scopes.includes("departments:manage"),
        );
        return Response.json({ data: { items: keys.map(presentApplicationKey) } }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        const databaseError = error as { code?: string; message?: string };
        logger.error("Could not list application keys", {
            code: databaseError.code,
            message: databaseError.message ?? "Unknown key listing error",
        });
        return errorResponse("service_unavailable", "Could not list API keys.", 503);
    }
}

async function handlePOST(request: Request): Promise<Response> {
    try {
        const application = await authenticateApplicationKey(request);
        if (!application) return errorResponse("unauthorized", "A valid API key is required.", 401);
        if (!application.scopes.includes(MANAGE_SCOPE)) {
            return errorResponse("forbidden", "The API key does not have keys:manage scope.", 403);
        }

        const parsed: unknown = await request.json().catch(() => null);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return errorResponse("invalid_json", "Request body must be a JSON object.", 400);
        }
        const body = parsed as CreateKeyRequest;
        const name = parseKeyName(body.name === undefined ? null : body.name);
        if (name === undefined) return errorResponse("invalid_key_name", "Use a name of 1 to 100 characters without credentials, or null.", 400);

        const expiresInDays = parseKeyExpiryDays(body.expiresInDays);
        if (expiresInDays === null) {
            return errorResponse("invalid_expiry", "expiresInDays must be an integer from 1 to 365.", 400);
        }

        const scopes = body.scopes === undefined ? ["files:read"] : body.scopes;
        if (
            !Array.isArray(scopes) ||
            scopes.length < 1 ||
            scopes.length > CREATABLE_SCOPES.size ||
            !scopes.every((scope): scope is string => typeof scope === "string" && CREATABLE_SCOPES.has(scope)) ||
            new Set(scopes).size !== scopes.length
        ) {
            return errorResponse("invalid_scopes", "scopes must contain unique files:read, files:write, and/or keys:manage values.", 400);
        }

        if (!Array.isArray(body.departmentGrants) || body.departmentGrants.length < 1 || body.departmentGrants.length > 100) {
            return errorResponse("invalid_department_grants", "departmentGrants must include at least one department role.", 400);
        }
        const departmentGrants: Array<{ id: string; code: string; name: string; role: "admin" | "editor" | "viewer" }> = [];
        const seenDepartments = new Set<string>();
        for (const entry of body.departmentGrants) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return errorResponse("invalid_department_grants", "Each grant requires departmentId and role.", 400);
            }
            const grant = entry as { departmentId?: unknown; role?: unknown };
            const departmentId = typeof grant.departmentId === "string" ? grant.departmentId : "";
            const role = grant.role;
            const department = application.departments.find((item) => item.id === departmentId);
            if (
                !department ||
                !["admin", "editor", "viewer"].includes(String(role)) ||
                !canDelegateDepartmentRole(application, departmentId, role as "admin" | "editor" | "viewer")
            ) {
                return errorResponse("department_grant_forbidden", "You cannot grant this role for the selected department.", 403);
            }
            if (seenDepartments.has(departmentId))
                return errorResponse("duplicate_department_grant", "A department can only appear once.", 400);
            seenDepartments.add(departmentId);
            departmentGrants.push({
                id: department.id,
                code: department.code,
                name: department.name,
                role: role as "admin" | "editor" | "viewer",
            });
        }
        if (scopes.includes("keys:manage") && departmentGrants.some((grant) => grant.role !== "admin")) {
            return errorResponse("invalid_management_role", "keys:manage requires the Admin role in every granted department.", 400);
        }

        const { keyPrefix, secretHash, apiKey } = generateApplicationKey();
        const record = await new PostgresApplicationKeyRepository().createForApplication({
            auditActor: application,
            tenantId: application.tenantId,
            applicationId: application.applicationId,
            keyPrefix,
            secretHash,
            name,
            scopes,
            expiresInDays,
            departmentGrants,
        });

        if (!record) return errorResponse("application_inactive", "The application is not active.", 409);

        return Response.json(
            {
                data: {
                    ...presentApplicationKey(record),
                    apiKey,
                    warning: "Copy this key now. Its secret cannot be retrieved again.",
                },
            },
            { status: 201, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
        );
    } catch (error) {
        const databaseError = error as { code?: string; message?: string };
        logger.error("Could not create application key", {
            code: databaseError.code,
            message: databaseError.message ?? "Unknown key creation error",
        });
        return errorResponse("service_unavailable", "Could not create API key.", 503);
    }
}

export const GET = auditRoute("key.list", "key", handleGET, { recordSuccess: false, signedUrl: false });
export const POST = auditRoute("key.create", "api_key", handlePOST, { recordSuccess: false, signedUrl: false });
