// Shared by the API and worker. Never serialize arbitrary errors or request data.
const sensitive = /password|passwd|authorization|cookie|secret|token|signed.?url|api.?key|database.?url|connection.?string/i;
export function redact(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value instanceof Error) return { name: value.name, code: safeCode(value.code) };
  if (typeof value === 'string') return value
    .replace(/(?:https?|postgres(?:ql)?|rediss?):\/\/[^\s"'<>]+/gi, raw => {
      try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return '[url]'; }
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bfsvc_[a-f\d]{12}\.[\w-]+/gi, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/\b(?:sb_secret_|sb_publishable_)[\w-]+/g, '[redacted]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 1024);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100)
    .map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  return undefined;
}
const allowed = new Set(['code','requestId','route','status','durationMs','fileId','versionId','resourceId','actorId','tenantId','applicationId','outboxId','action','target','count','scheduled','processed','deletedEvents','deletedSecurityEvents','droppedPartitions','policy','retryAfter']);
function safeCode(code) { return typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : undefined; }
function emit(level, event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
  if ('code' in safe) safe.code = safeCode(safe.code);
  if (typeof safe.route === 'string') safe.route = safe.route.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, ':id');
  // Event text is developer controlled; free-form error.message is deliberately omitted.
  console[level](JSON.stringify({ time: new Date().toISOString(), level, event: redact(event), ...redact(safe) }));
}
export const logger = {
  info: (event, fields) => emit('log', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
const last = new Map();
export function securityWarning(event, fields) {
  const now = Date.now();
  if (now - (last.get(event) ?? 0) < 10_000) return;
  last.set(event, now);
  logger.warn(event, fields);
}

// Audit is business evidence: reject unsafe details rather than silently alter it.
export function validateAuditDetails(details = {}) {
  for (const [key, value] of Object.entries(details)) {
    if (sensitive.test(key) || (typeof value === 'string' &&
      (/\b(?:Bearer\s|fsvc_[a-f\d]{12}\.|eyJ[\w-]+\.[\w-]+\.|sb_secret_)/i.test(value) ||
       /(?:postgres(?:ql)?|rediss?):\/\//i.test(value) || unsafeUrl(value) ||
       /\b(?:password|token|secret|api[_-]?key)\s*[=:]/i.test(value)))) {
      throw Object.assign(new Error('Unsafe audit detail'), { code: 'UNSAFE_AUDIT_DETAIL' });
    }
    if (value !== null && !['string','number','boolean'].includes(typeof value)) throw new Error('Invalid audit detail');
  }
  return details;
}
function unsafeUrl(value) {
  for (const match of value.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password || /\/storage\/v1\/object\/(?:sign|upload\/sign)\//i.test(url.pathname) ||
          [...url.searchParams.keys()].some(key => /token|signature|secret|api.?key|password|credential|^sig$/i.test(key))) return true;
    } catch { return true; }
  }
  return false;
}
