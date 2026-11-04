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
      let stage = 'rate_limit_ip';
      try {
        await consume(`ip:${clientAddress(request)}`, [['ip', 1]], requestId);
        stage = 'read_body';
        const { bytes, value } = await readBoundedBody(request);
        stage = 'rebuild_request';
        // Next.js may proxy the incoming Request. Undici cannot copy its private
        // internal state after the body was read; rebuild using public properties.
        const secured = bytes === null ? request : new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: bytes,
          signal: request.signal,
        });
        stage = 'authenticate';
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
          stage = 'rate_limit_identity';
          await consume(`${app.tenantId}:${app.applicationId}:${app.userId ? `user:${app.userId}` : `key:${app.keyId}`}`, charges, requestId);
        }
        stage = 'handle_request';
        const response = await handler(secured, ...args);
        response.headers.set('X-Request-Id', requestId);
        return response;
      } catch (error) {
        if (!(error instanceof SecurityError)) logger.error('api_request_failed', { requestId, code: stage });
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
