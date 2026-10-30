import "server-only";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import type { AuthenticatedApplication } from "@/application/auth/authenticated-application";
import { getDatabasePool } from "@/infrastructure/database/pool";

export const auditRequestContext = new AsyncLocalStorage<string>();

export type AuditOutcome = "success" | "denied" | "failure";
export type AuditEvent = {
    action: string;
    outcome: AuditOutcome;
    resourceType?: string;
    resourceId?: string | null;
    requestId?: string;
    details?: Record<string, string | number | boolean | null>;
};

export async function recordAudit(app: AuthenticatedApplication, event: AuditEvent, client?: PoolClient): Promise<void> {
    const sql = `insert into filesvc.audit_log
    (tenant_id, application_id, actor_kind, actor_id, action, outcome, resource_type, resource_id, request_id, details)
    values ($1, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10::jsonb)`;
    const values = [
        app.tenantId,
        app.applicationId,
        app.userId ? "user" : "api_key",
        app.userId ?? app.keyId,
        event.action,
        event.outcome,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.requestId ?? auditRequestContext.getStore() ?? randomUUID(),
        JSON.stringify(event.details ?? {}),
    ];
    await (client ?? getDatabasePool()).query(sql, values);
}

export async function recordUnidentifiedDenial(action: string, route: string, status: number, requestId = randomUUID()): Promise<void> {
    await getDatabasePool().query(
        `insert into filesvc.audit_security_events (action, outcome, request_id, route, status)
     values ($1, 'denied', $2, $3, $4)`,
        [action, requestId, route, status],
    );
}
