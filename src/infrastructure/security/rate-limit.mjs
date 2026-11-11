import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { SecurityError } from "./request-body.mjs";
import { securityWarning } from "./logger.mjs";

export const policies = {
    ip: [600, 60],
    identity: [300, 60],
    grants: [60, 60],
    uploads: [120, 60],
    destructive: [10, 60],
    invites: [10, 3600],
    keys: [20, 3600],
};
export function mode() {
    const value = process.env.RATE_LIMIT_MODE ?? "report";
    if (!["report", "enforce"].includes(value)) throw new SecurityError("security_control_unavailable", 503);
    return value;
}
export function clientAddress(request) {
    const trust = process.env.TRUSTED_PROXY_MODE ?? "local";
    if (!["local", "railway"].includes(trust)) throw new SecurityError("security_control_unavailable", 503);
    if (trust === "local") return "local"; // Never trust caller-supplied forwarding headers locally.
    const address = request.headers.get("x-real-ip")?.trim();
    return address && isIP(address) ? address.toLowerCase() : "unknown";
}
export function policyFor(path, method) {
    if (/\/(preview|download)-url$/.test(path)) return "grants";
    if (/\/upload-intents(?:\/batch)?$/.test(path)) return "uploads";
    if (/\/versions\/[^/]+\/restore$/.test(path) || path.endsWith("/purge")) return "destructive";
    if (path.endsWith("/users/invite")) return "invites";
    if (/\/keys(?:\/[^/]+)?$/.test(path) && ["POST", "DELETE"].includes(method)) return "keys";
    if (method === "POST" && /\/keys\/[^/]+\/rotate\/?$/.test(path)) return "keys";
}
// Redis TIME and a single script provide a common clock and atomic multi-bucket admission.
export const bucketScript = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) + tonumber(clock[2]) / 1000000
local entries = {}
local retry = 0
for i,key in ipairs(KEYS) do
  local base = (i-1)*3
  local capacity = tonumber(ARGV[base+1])
  local period = tonumber(ARGV[base+2])
  local cost = tonumber(ARGV[base+3])
  local old = redis.call('HMGET',key,'tokens','time')
  local tokens = capacity
  if old[1] then tokens = math.min(capacity,tonumber(old[1]) + math.max(0,now-tonumber(old[2])) * capacity/period) end
  if tokens < cost then retry = math.max(retry,math.ceil((cost-tokens)*period/capacity)) end
  entries[i] = {tokens=tokens,cost=cost,period=period}
end
if retry > 0 then return retry end
for i,key in ipairs(KEYS) do
  redis.call('HSET',key,'tokens',entries[i].tokens-entries[i].cost,'time',now)
  redis.call('EXPIRE',key,math.ceil(entries[i].period*2))
end
return 0`;

let client, connecting, initializing;
export async function getRedis() {
    if (!process.env.REDIS_URL) throw new Error("REDIS_NOT_CONFIGURED");
    if (!client) {
        initializing ??= (async () => {
            const { createClient } = await import("redis");
            client = createClient({
                url: process.env.REDIS_URL,
                socket: { connectTimeout: 2000, reconnectStrategy: false },
                disableOfflineQueue: true,
                commandsQueueMaxLength: 1000,
            });
            client.on("error", () => securityWarning("redis_unavailable", {}));
        })().finally(() => {
            initializing = undefined;
        });
        await initializing;
    }
    if (!client.isReady) {
        connecting ??= client.connect().finally(() => {
            connecting = undefined;
        });
        await connecting;
    }
    return client;
}
export async function closeRedis() {
    if (client?.isOpen) client.destroy();
    client = undefined;
    connecting = undefined;
    initializing = undefined;
}
function config(name) {
    const [defaultCapacity, period] = policies[name];
    const capacity = Number(process.env[`RATE_LIMIT_${name.toUpperCase()}_CAPACITY`] ?? defaultCapacity);
    // A full supported batch must fit into the uploads bucket.
    if (!Number.isSafeInteger(capacity) || capacity < (name === "uploads" ? 20 : 1) || capacity > 1_000_000)
        throw new Error("INVALID_RATE_CAPACITY");
    return [capacity, period];
}
export function bucketKey(subject, policy) {
    const secret = process.env.RATE_LIMIT_KEY_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error("INVALID_RATE_SECRET");
    const env = process.env.SECURITY_ENVIRONMENT ?? process.env.RAILWAY_ENVIRONMENT_ID ?? process.env.NODE_ENV ?? "development";
    const digest = createHmac("sha256", secret).update(`${env}:${subject}`).digest("hex");
    return `efin:rl:${env.replace(/[^\w-]/g, "_")}:{${digest}}:${policy}`;
}
export async function consume(subject, charges, requestId) {
    const activeMode = mode();
    try {
        const keys = [],
            args = [];
        for (const [policy, cost] of charges) {
            const [capacity, period] = config(policy);
            if (!Number.isSafeInteger(cost) || cost < 1 || cost > capacity) throw new Error("INVALID_RATE_COST");
            keys.push(bucketKey(subject, policy));
            args.push(String(capacity), String(period), String(cost));
        }
        const redis = await getRedis();
        const retry = Number(await redis.withCommandOptions({ timeout: 2000 }).eval(bucketScript, { keys, arguments: args }));
        if (!Number.isSafeInteger(retry) || retry < 0) throw new Error("INVALID_RATE_RESULT");
        if (retry) {
            securityWarning("rate_limited", { requestId, policy: charges.map((c) => c[0]).join(","), retryAfter: retry });
            if (activeMode === "enforce") throw new SecurityError("rate_limited", 429, retry);
        }
    } catch (error) {
        if (error instanceof SecurityError) throw error;
        securityWarning("security_control_unavailable", { requestId });
        if (activeMode === "enforce") throw new SecurityError("security_control_unavailable", 503, 5);
    }
}
export async function checkRedisReady() {
    if (mode() === "enforce") {
        bucketKey("readiness", "identity");
        for (const name of Object.keys(policies)) config(name);
        const redis = await getRedis();
        await redis.withCommandOptions({ timeout: 2000 }).ping();
    }
}
