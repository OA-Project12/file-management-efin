export class SecurityError extends Error {
  constructor(code, status, retryAfter) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export function bodyLimit(path) {
  if (path.endsWith('/upload-intents/batch')) return 64 * 1024;
  if (path.endsWith('/upload-intents') || path.endsWith('/metadata') || path.includes('/users') || /\/folders\/[^/]+\/access$/.test(path)) return 16 * 1024;
  return 4096;
}
export async function readBoundedBody(request, limit = bodyLimit(new URL(request.url).pathname), timeoutMs = 10_000) {
  if (!request.body) return { bytes: null, value: undefined };
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json' && !/^application\/[\w.+-]+\+json$/.test(type)) throw new SecurityError('unsupported_media_type', 415);
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(limit)) throw new SecurityError('request_too_large', 413);
  const reader = request.body.getReader(), chunks = [];
  let length = 0, timer;
  // This race only bounds body reads; no application operation has started yet.
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new SecurityError('request_timeout', 408)); }, timeoutMs);
  });
  try {
    await Promise.race([deadline, (async () => {
      while (true) {
        const part = await reader.read();
        if (part.done) return;
        length += part.value.byteLength;
        if (length > limit) { void reader.cancel().catch(() => {}); throw new SecurityError('request_too_large', 413); }
        chunks.push(part.value);
      }
    })()]);
    const bytes = Buffer.concat(chunks);
    if (!bytes.length) return { bytes, value: undefined };
    try { return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
    catch { throw new SecurityError('invalid_json', 400); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
