import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { canSeeFile } from "@/application/auth/folder-visibility";
import { departmentIdsForRole } from "@/application/auth/department-authorization";
import { PostgresFileRepository } from "@/infrastructure/database/postgres-file-repository";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ fileId: string }> }): Promise<Response> {
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return fail("unauthorized", "A valid API key is required.", 401);
        if (!app.scopes.includes("files:write")) return fail("forbidden", "files:write scope is required.", 403);
        const { fileId } = await params;
        if (!UUID_PATTERN.test(fileId)) return fail("invalid_file_id", "fileId must be a UUID.", 400);
        if (!await canSeeFile(app, fileId)) return fail("file_not_found", "File was not found in trash.", 404);
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return fail("invalid_json", "Request body must be valid JSON.", 400);
        }
        const ownerSubject = app.userId ? null :
            body && typeof body === "object" && !Array.isArray(body) && "ownerSubject" in body && typeof body.ownerSubject === "string"
                ? body.ownerSubject.trim()
                : "";
        if (!app.userId && (!ownerSubject || ownerSubject.length > 255))
            return fail("invalid_owner_subject", "ownerSubject must contain 1 to 255 characters.", 400);
        const result = await new PostgresFileRepository().requestPurge(fileId, {
            tenantId: app.tenantId,
            applicationId: app.applicationId,
            ownerSubject,
            departmentIds: departmentIdsForRole(app, "admin"),
        });
        if (result === "not_found") return fail("file_not_found", "File was not found in trash or Admin access is required.", 404);
        return Response.json(
            { data: { fileId, status: "deleting", purgeRequested: true } },
            { status: 202, headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("Could not purge file", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not purge file.", 503);
    }
}
