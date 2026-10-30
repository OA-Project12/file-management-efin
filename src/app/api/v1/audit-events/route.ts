import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { connection } from "next/server";
import { getDatabasePool } from "@/infrastructure/database/pool";
import { auditRoute } from "@/infrastructure/audit/audit-route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.]{0,79}$/;
const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });

async function handleGET(request: Request): Promise<Response> {
    await connection();
    try {
        const app = await authenticateApplicationKey(request);
        if (!app) return fail("unauthorized", "A valid user session is required.", 401);
        if (!app.userId || !app.isTenantAdmin) return fail("forbidden", "Tenant Admin access is required.", 403);
        const query = new URL(request.url).searchParams;
        const limit = Number(query.get("limit") ?? "25");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_limit", "limit must be between 1 and 100.", 400);
        const action = query.get("action");
        const outcome = query.get("outcome");
        const actorId = query.get("actorId");
        const resourceId = query.get("resourceId");
        if (action && !ACTION.test(action)) return fail("invalid_action", "Invalid action.", 400);
        if (outcome && !["success", "denied", "failure"].includes(outcome)) return fail("invalid_outcome", "Invalid outcome.", 400);
        if ((actorId && !UUID.test(actorId)) || (resourceId && !UUID.test(resourceId)))
            return fail("invalid_id", "IDs must be UUIDs.", 400);
        const from = query.get("from");
        const to = query.get("to");
        if (
            (from && !Number.isFinite(Date.parse(from))) ||
            (to && !Number.isFinite(Date.parse(to))) ||
            (from && to && Date.parse(from) >= Date.parse(to))
        )
            return fail("invalid_date_range", "Invalid time range.", 400);
        let cursor: { occurredAt: string; id: string } | null = null;
        if (query.has("cursor")) {
            if ((query.get("cursor")?.length ?? 0) > 512) return fail("invalid_cursor", "Invalid cursor.", 400);
            try {
                const parsed: unknown = JSON.parse(Buffer.from(query.get("cursor")!, "base64url").toString("utf8"));
                if (!parsed || typeof parsed !== "object") throw new Error();
                const value = parsed as { occurredAt?: unknown; id?: unknown };
                if (
                    typeof value.occurredAt !== "string" ||
                    !Number.isFinite(Date.parse(value.occurredAt)) ||
                    typeof value.id !== "string" ||
                    !UUID.test(value.id)
                )
                    throw new Error();
                cursor = { occurredAt: value.occurredAt, id: value.id };
            } catch {
                return fail("invalid_cursor", "Invalid cursor.", 400);
            }
        }
        const result = await getDatabasePool().query<{
            id: string;
            occurred_at: Date;
            actor_kind: string;
            actor_id: string | null;
            action: string;
            outcome: string;
            resource_type: string | null;
            resource_id: string | null;
            request_id: string;
            details: Record<string, unknown>;
        }>(
            `select id, occurred_at, actor_kind, actor_id, action, outcome, resource_type, resource_id, request_id, details
       from filesvc.audit_log
       where tenant_id = $1 and application_id = $2
         and ($3::text is null or action = $3)
         and ($4::text is null or outcome = $4)
         and ($5::uuid is null or actor_id = $5)
         and ($6::uuid is null or resource_id = $6)
         and ($7::timestamptz is null or occurred_at >= $7)
         and ($8::timestamptz is null or occurred_at < $8)
         and ($9::timestamptz is null or (occurred_at, id) < ($9::timestamptz, $10::uuid))
       order by occurred_at desc, id desc limit $11`,
            [
                app.tenantId,
                app.applicationId,
                action,
                outcome,
                actorId,
                resourceId,
                from,
                to,
                cursor?.occurredAt ?? null,
                cursor?.id ?? null,
                limit + 1,
            ],
        );
        const rows = result.rows.slice(0, limit);
        const last = rows.at(-1);
        const nextCursor =
            result.rows.length > limit && last
                ? Buffer.from(JSON.stringify({ occurredAt: last.occurred_at.toISOString(), id: last.id })).toString("base64url")
                : null;
        return Response.json(
            {
                data: {
                    items: rows.map((row) => ({
                        id: row.id,
                        occurredAt: row.occurred_at,
                        actorKind: row.actor_kind,
                        actorId: row.actor_id,
                        action: row.action,
                        outcome: row.outcome,
                        resourceType: row.resource_type,
                        resourceId: row.resource_id,
                        requestId: row.request_id,
                        details: row.details,
                    })),
                    nextCursor,
                },
            },
            { headers: { "Cache-Control": "no-store" } },
        );
    } catch (error) {
        console.error("Could not list audit events", { message: error instanceof Error ? error.message : "Unknown error" });
        return fail("service_unavailable", "Could not list audit events.", 503);
    }
}

export const GET = auditRoute("audit.read", "audit_event", handleGET, { recordSuccess: false });
