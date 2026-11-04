import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readBoundedBody, bodyLimit } from '../src/infrastructure/security/request-body.mjs';
import { redact, validateAuditDetails, logger } from '../src/infrastructure/security/logger.mjs';
import { securityHeaders } from '../src/infrastructure/security/headers.mjs';
import { boundedFetch } from '../src/infrastructure/security/supabase-fetch.mjs';
import { consume, clientAddress, bucketKey, closeRedis, getRedis, policyFor, bucketScript } from '../src/infrastructure/security/rate-limit.mjs';

const namespace = `test-${randomUUID()}`;
process.env.SECURITY_ENVIRONMENT = namespace;
process.env.RATE_LIMIT_KEY_SECRET = 'synthetic-test-secret-at-least-32-characters';
process.env.RATE_LIMIT_MODE = 'enforce';
after(async () => { await closeRedis(); });
const request = body => new Request('http://fixture/api/v1/files/search', { method: 'POST', body: Buffer.from(body) });

test('bounded JSON counts UTF-8 bytes and refuses declared and streamed oversize', async () => {
  const body = JSON.stringify({ text: 'ภาษาไทย' });
  const bytes = Buffer.byteLength(body);
  assert.equal((await readBoundedBody(request(body), bytes)).value.text, 'ภาษาไทย');
  await assert.rejects(readBoundedBody(request(body), bytes - 1), { code: 'request_too_large', status: 413 });
  const stream = new ReadableStream({ start(c) { c.enqueue(Buffer.from(body.slice(0, 5))); c.enqueue(Buffer.from(body.slice(5))); c.close(); } });
  await assert.rejects(readBoundedBody(new Request('http://fixture', { method: 'POST', body: stream, duplex: 'half' }), 4), { status: 413 });
  await assert.rejects(readBoundedBody(new Request('http://fixture', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': '9999' } }), 4), { status: 413 });
  assert.equal(bodyLimit('/api/v1/files/upload-intents/batch'), 65536);
  assert.equal(bodyLimit('/api/v1/files/123/metadata'), 16384);
  assert.equal(bodyLimit('/api/v1/files/123/versions/456/preview-url'), 4096);
});
test('JSON compatibility, type checks and timeout cancel the body before work starts', async () => {
  assert.deepEqual((await readBoundedBody(new Request('http://fixture', { method: 'POST', body: Buffer.from('{}') }))).value, {});
  await assert.rejects(readBoundedBody(request('{')), { code: 'invalid_json', status: 400 });
  await assert.rejects(readBoundedBody(new Request('http://fixture', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/html' } })), { status: 415 });
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(new Request('http://fixture', { method: 'POST', body: stream, duplex: 'half' }), 100, 10), { status: 408 });
  assert.equal(cancelled, true);
});
test('logger redacts nested credentials and uses an allowlist instead of raw errors/messages', () => {
  const secret = 'fsvc_' + randomUUID().replaceAll('-', '').slice(0, 12) + '.' + 'x'.repeat(43);
  const value = redact({ nested: { password: 'bad-password', signedUrl: 'https://storage.invalid/file?token=hidden' }, text: `Bearer ${secret}\nhttps://user:pass@db.invalid/path?token=hidden` });
  const output = JSON.stringify(value);
  for (const hidden of ['bad-password', secret, 'token=hidden', 'user:pass', '\\n']) assert.ok(!output.includes(hidden));
  const lines = [], old = console.error;
  try {
    console.error = line => lines.push(line);
    logger.error('test_failure', { requestId: 'id', message: secret, body: { secret }, code: 'TEST' });
  } finally { console.error = old; }
  assert.equal(JSON.parse(lines[0]).requestId, 'id');
  assert.ok(!lines[0].includes(secret));
  for (const details of [{ token: 'x' }, { nested: { password: 'x' } }, { name: secret }, { name: 'https://storage.invalid/a?token=x' }]) assert.throws(() => validateAuditDetails(details));
  assert.deepEqual(validateAuditDetails({ versionId: 'id', sizeBytes: '42', name: 'เอกสาร.pdf' }), { versionId: 'id', sizeBytes: '42', name: 'เอกสาร.pdf' });
});
test('production CSP allows only configured Storage origin and does not enable eval or HSTS preload', () => {
  const headers = Object.fromEntries(securityHeaders('production', 'https://fixture.supabase.co').map(h => [h.key, h.value]));
  assert.ok(headers['Content-Security-Policy'].includes('https://fixture.supabase.co'));
  assert.ok(!headers['Content-Security-Policy'].includes('unsafe-eval'));
  assert.ok(!headers['Content-Security-Policy'].includes('*.supabase.co'));
  assert.ok(headers['Content-Security-Policy'].includes("frame-ancestors 'none'"));
  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.ok(!securityHeaders('development').some(h => h.key === 'Strict-Transport-Security'));
});
test('trusted IP ignores spoofed XFF, unknown IP is not exempt, local ignores all forwarding headers', () => {
  const req = new Request('http://fixture', { headers: { 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '203.0.113.4' } });
  process.env.TRUSTED_PROXY_MODE = 'railway';
  assert.equal(clientAddress(req), '203.0.113.4');
  assert.equal(clientAddress(new Request('http://fixture', { headers: { 'X-Real-IP': 'invalid' } })), 'unknown');
  process.env.TRUSTED_PROXY_MODE = 'local';
  assert.equal(clientAddress(req), 'local');
  assert.notEqual(bucketKey('tenant-a:app:user', 'identity'), bucketKey('tenant-b:app:user', 'identity'));
  assert.ok(!bucketKey('ip:203.0.113.4', 'ip').includes('203.0.113.4'));
});
test('network timeout aborts the actual fetch without retrying', async () => {
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, { signal }) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); };
  try {
    // Keep the event loop alive: AbortSignal.timeout itself uses an unref timer.
    const keepAlive = setTimeout(() => {}, 100);
    await assert.rejects(boundedFetch('https://fixture.invalid', {}, 5));
    clearTimeout(keepAlive);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = old; }
});
test('route groups include all current and historical grants/upload/restore operations', () => {
  assert.equal(policyFor('/api/v1/files/id/versions/id/preview-url', 'POST'), 'grants');
  assert.equal(policyFor('/api/v1/files/id/versions/upload-intents', 'POST'), 'uploads');
  assert.equal(policyFor('/api/v1/files/id/versions/id/restore', 'POST'), 'destructive');
  assert.equal(policyFor('/api/v1/keys/id', 'DELETE'), 'keys');
});
test('Redis token buckets: concurrency, atomic multi-bucket denial, refill, TTL, batch charging and multiple processes', async () => {
  assert.ok(process.env.REDIS_URL, 'Set REDIS_URL to disposable test Redis');
  process.env.RATE_LIMIT_KEYS_CAPACITY = '3';
  const subject = randomUUID();
  const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => consume(subject, [['identity', 1], ['keys', 1]], 'test')));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 3);
  const redis = await getRedis();
  assert.equal(Math.floor(Number(await redis.hGet(bucketKey(subject, 'identity'), 'tokens'))), 297);
  assert.ok(await redis.ttl(bucketKey(subject, 'keys')) > 0);
  const upload = randomUUID();
  for (let i = 0; i < 6; i++) await consume(upload, [['uploads', 20]], 'test');
  await assert.rejects(consume(upload, [['uploads', 1]], 'test'), { code: 'rate_limited', status: 429 });
  const key = bucketKey(randomUUID(), 'keys');
  const t = await redis.time();
  const now = Array.isArray(t) ? Number(t[0]) : Date.now() / 1000;
  await redis.hSet(key, { tokens: '0', time: String(now - 2) });
  assert.equal(Number(await redis.eval(bucketScript, { keys: [key], arguments: ['1','1','1'] })), 0);
  const shared = randomUUID();
  const code = `import {consume,closeRedis} from './src/infrastructure/security/rate-limit.mjs';
    const r=await Promise.allSettled(Array.from({length:5},()=>consume(process.env.TEST_SUBJECT,[['keys',1]],'child')));
    console.log('ACCEPTED='+r.filter(x=>x.status==='fulfilled').length);await closeRedis();`;
  const run = async () => {
    const child = spawn(process.execPath, ['--input-type=module','-e',code], { env: { ...process.env, TEST_SUBJECT: shared }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk);
    const [exit] = await once(child, 'exit'); assert.equal(exit, 0);
    return Number(/ACCEPTED=(\d+)/.exec(output)?.[1]);
  };
  const counts = await Promise.all([run(), run()]);
  assert.equal(counts[0] + counts[1], 3);
});
test('Redis outage fails closed in enforce, allows report mode without memory fallback', async () => {
  await closeRedis();
  const url = process.env.REDIS_URL;
  process.env.REDIS_URL = 'redis://127.0.0.1:1';
  await assert.rejects(consume('outage', [['identity', 1]], 'test'), { code: 'security_control_unavailable', status: 503 });
  process.env.RATE_LIMIT_MODE = 'report';
  await consume('outage', [['identity', 1]], 'test');
  await closeRedis(); process.env.REDIS_URL = url; process.env.RATE_LIMIT_MODE = 'enforce';
});
