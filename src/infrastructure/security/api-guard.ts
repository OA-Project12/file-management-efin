import "server-only";
import { randomUUID } from "node:crypto";
import { connection } from "next/server";
import { authenticateApplicationKey } from "@/infrastructure/auth/application-key-authenticator";
import { auditRequestContext } from "@/infrastructure/audit/record-audit";
import { consume, clientAddress, policyFor } from "./rate-limit.mjs";
import { readBoundedBody, SecurityError } from "./request-body.mjs";
import { logger } from "./logger.mjs";

export function securityRoute<Args extends unknown[]>(handler: (request: Request, ...args: Args) => Promise<Response>) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    // Keep Next.js prerender bailouts outside our error boundary; never contact Redis/Auth at build time.
    await connection();
    const requestId = randomUUID();
    return auditRequestContext.run(requestId, async () => {
      try {
        await consume(`ip:${clientAddress(request)}`, [['ip', 1]], requestId);
        const { bytes, value } = await readBoundedBody(request);
        const secured = bytes === null ? request : new Request(request, { body: bytes });
        const app = await authenticateApplicationKey(secured);
        if (app) {
          const path = new URL(request.url).pathname;
          const policy = policyFor(path, request.method);
          const charges: [string, number][] = [['identity', 1]];
          if (policy) {
            let cost = 1;
            if (path.endsWith('/upload-intents/batch')) {
              const items = value?.files;
              if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
                // Existing handler owns the detailed shape validation; never issue intents here.
                cost = 20;
              } else cost = items.length;
            }
            charges.push([policy, cost]);
          }
          await consume(`${app.tenantId}:${app.applicationId}:${app.userId ? `user:${app.userId}` : `key:${app.keyId}`}`, charges, requestId);
        }
        const response = await handler(secured, ...args);
        response.headers.set('X-Request-Id', requestId);
        return response;
      } catch (error) {
        if (!(error instanceof SecurityError)) logger.error('api_request_failed', { requestId });
        const status = error instanceof SecurityError ? error.status : 503;
        const code = error instanceof SecurityError ? error.code : 'service_unavailable';
        return Response.json({ error: { code, message: code.replaceAll('_', ' '), requestId } }, {
          status, headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId,
            ...(error instanceof SecurityError && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) },
        });
      }
    });
  };
}
