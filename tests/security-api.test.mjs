import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import pg from 'pg';
import { closeRedis } from '../src/infrastructure/security/rate-limit.mjs';

const connection = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['localhost','127.0.0.1','postgres'].includes(connection.hostname) && connection.pathname === '/efin_security', 'Disposable fixture database required');
const pool = new pg.Pool({ connectionString: connection.toString(), max: 3, statement_timeout: 15000, lock_timeout: 5000 });
process.env.SECURITY_ENVIRONMENT = `api-${randomUUID()}`;
process.env.RATE_LIMIT_KEY_SECRET = randomBytes(32).toString('hex');
process.env.RATE_LIMIT_MODE = 'enforce';
process.env.TRUSTED_PROXY_MODE = 'railway';
const modules = new Map(), require = createRequire(import.meta.url);
let queries = 0;
const testPool = { query: (...args) => { queries++; return pool.query(...args); }, connect: () => pool.connect() };
function load(file) {
  file = path.resolve(file);
  if (file.endsWith('.mjs')) return require(file);
  if (modules.has(file)) return modules.get(file).exports;
  const fixtureModule = { exports: {} }; modules.set(file, fixtureModule);
  const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const resolve = name => {
    if (name === 'server-only') return {};
    if (name === 'next/server') return { connection: async () => {} };
    if (name === '@/infrastructure/database/pool' || (name === './pool' && file.includes('database'))) return { getDatabasePool: () => testPool };
    // JWT cryptographic validation belongs to Supabase; test membership/roles with deterministic verified claims.
    if (name === '@supabase/supabase-js') return { createClient: () => ({ auth: { getClaims: async token => ({ data: token === 'verified-fixture-token' ? { claims: { sub: user } } : null }) } }) };
    if (name.startsWith('@/')) return load(path.join('src', name.slice(2) + (name.endsWith('.mjs') ? '' : '.ts')));
    if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + (name.endsWith('.mjs') ? '' : '.ts')));
    return require(name);
  };
  new Function('require', 'module', 'exports', js)(resolve, fixtureModule, fixtureModule.exports);
  return fixtureModule.exports;
}
const tenant = randomUUID(), app = randomUUID(), dept = randomUUID(), user = randomUUID(), keyId = randomUUID();
const secret = randomBytes(32).toString('base64url'), prefix = `fsvc_${randomBytes(6).toString('hex')}`, key = `${prefix}.${secret}`;
process.env.AUTH_APPLICATION_ID = app;
process.env.SUPABASE_URL = 'https://fixture.supabase.co'; process.env.SUPABASE_SECRET_KEY = 'fixture-only';
await pool.query("insert into filesvc.tenants(id,name) values($1,'Security fixture')", [tenant]);
await pool.query("insert into filesvc.applications(id,tenant_id,name) values($1,$2,'Security app')", [app,tenant]);
await pool.query("insert into filesvc.departments(id,tenant_id,application_id,code,name) values($1,$2,$3,'security','Security')", [dept,tenant,app]);
await pool.query('insert into filesvc.tenant_users(tenant_id,user_id,is_admin) values($1,$2,true)',[tenant,user]);
await pool.query('insert into filesvc.application_keys(id,tenant_id,application_id,key_prefix,secret_hash,scopes) values($1,$2,$3,$4,$5,$6)', [keyId,tenant,app,prefix,createHash('sha256').update(secret).digest(),['files:read']]);
await pool.query("insert into filesvc.application_key_departments(application_key_id,department_id,role) values($1,$2,'viewer')",[keyId,dept]);
const { GET: me } = load('src/app/api/v1/me/route.ts');
const call = (token = key) => me(new Request('http://fixture/api/v1/me', { headers: { Authorization: `Bearer ${token}`, 'X-Real-IP': '203.0.113.5' } }));
after(async () => { await closeRedis(); await pool.end(); });

test('actual API key authentication: hash, expiry, revoke, parent suspension and request-local auth cache', async () => {
  queries = 0;
  const good = await call();
  assert.equal(good.status, 200); assert.equal((await good.json()).applicationId, app);
  assert.equal(queries, 3, 'One lookup/touch/departments query set per Request');
  assert.ok(good.headers.get('x-request-id'));
  assert.equal((await call(`${prefix}.${'z'.repeat(43)}`)).status, 401);
  await pool.query('update filesvc.application_keys set expires_at=now()-interval \'1 second\' where id=$1',[keyId]);
  assert.equal((await call()).status, 401);
  await pool.query('update filesvc.application_keys set expires_at=null,revoked_at=now() where id=$1',[keyId]);
  assert.equal((await call()).status, 401);
  await pool.query('update filesvc.application_keys set revoked_at=null where id=$1',[keyId]);
  await pool.query("update filesvc.applications set status='suspended' where id=$1",[app]);
  assert.equal((await call()).status, 401);
  await pool.query("update filesvc.applications set status='active' where id=$1",[app]);
});
test('Auth user session loads server-side membership and does not acquire keys:manage', async () => {
  let result = await call('verified-fixture-token'); assert.equal(result.status, 200);
  const identity = await result.json(); assert.equal(identity.userId, user); assert.equal(identity.isTenantAdmin, true);
  assert.ok(!identity.scopes.includes('keys:manage'));
  const { authenticateApplicationKey } = load('src/infrastructure/auth/application-key-authenticator.ts');
  const sameRequest = new Request('http://fixture', { headers: { Authorization: 'Bearer verified-fixture-token' } });
  assert.ok(await authenticateApplicationKey(sameRequest));
  await pool.query("update filesvc.tenant_users set status='suspended' where user_id=$1",[user]);
  assert.equal(await authenticateApplicationKey(sameRequest, true), null, 'Restore explicitly reloads membership after the Storage copy');
  result = await call('verified-fixture-token'); assert.equal(result.status, 401);
  await pool.query("update filesvc.tenant_users set status='active' where user_id=$1",[user]);
});
test('guard returns 429/Retry-After without replay and charges batch by number of files', async () => {
  const { securityRoute } = load('src/infrastructure/security/api-guard.ts');
  let mutations = 0;
  const route = securityRoute(async () => { mutations++; return Response.json({ data: {} }); });
  const req = (path, body) => new Request(`http://fixture/api/v1${path}`, { method:'POST', body:JSON.stringify(body), headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'} });
  process.env.RATE_LIMIT_KEYS_CAPACITY='1';
  assert.equal((await route(req('/keys',{}))).status,200);
  const denied = await route(req('/keys',{}));
  assert.equal(denied.status,429); assert.ok(Number(denied.headers.get('retry-after')) > 0);
  assert.equal((await denied.json()).error.code,'rate_limited'); assert.equal(mutations,1);
  delete process.env.RATE_LIMIT_KEYS_CAPACITY;
  process.env.RATE_LIMIT_UPLOADS_CAPACITY='20';
  assert.equal((await route(req('/files/upload-intents/batch',{files:Array(20).fill({})}))).status,200);
  assert.equal((await route(req('/files/upload-intents/batch',{files:[{}]}))).status,429);
  assert.equal(mutations,2); delete process.env.RATE_LIMIT_UPLOADS_CAPACITY;
});
test('guard returns bounded errors before mutation, retains signed URL audit failure behavior', async () => {
  const { auditRoute } = load('src/infrastructure/audit/audit-route.ts');
  let mutations = 0;
  const handler = auditRoute('fixture.write','file',async () => { mutations++; return Response.json({ data: {} }); }, { recordSuccess: false });
  const make = (body, type = 'application/json') => new Request('http://fixture/api/v1/departments', { method: 'POST', body, headers: { Authorization: `Bearer ${key}`, 'Content-Type': type } });
  for (const [body,type,status] of [['x'.repeat(4097),'application/json',413],['{','application/json',400],['{}','text/plain',415]]) {
    const response = await handler(make(body,type)); assert.equal(response.status,status); assert.equal(response.headers.get('cache-control'),'no-store');
  }
  assert.equal(mutations,0);
  const url = auditRoute('fixture.preview','file',async () => Response.json({ data: { signedUrl: 'https://fixture.invalid/?token=never-log' } }), { signedUrl: true });
  // A handler that would return a URL without authenticated audit evidence must fail closed.
  const response = await url(new Request('http://fixture/api/v1/files/invalid/preview-url'));
  assert.equal(response.status,503); assert.ok(!(await response.text()).includes('never-log'));
});
test('Redis unavailable blocks before authentication/mutation and health is outside the guard', async () => {
  const { securityRoute } = load('src/infrastructure/security/api-guard.ts');
  const url = process.env.REDIS_URL; await closeRedis(); process.env.REDIS_URL='redis://127.0.0.1:1';
  let mutations=0; queries=0;
  const route = securityRoute(async () => { mutations++; return Response.json({}); });
  const response = await route(new Request('http://fixture/api/v1/test'));
  assert.equal(response.status,503); assert.equal(mutations,0); assert.equal(queries,0);
  await closeRedis(); process.env.REDIS_URL=url;
  assert.equal((await load('src/app/api/health/live/route.ts').GET()).status,200);
});
test('database statement and lock timeouts abort operations; audit validation rolls back mutation', async () => {
  const client = await pool.connect();
  try {
    await client.query('begin'); await client.query("set local statement_timeout='20ms'");
    await assert.rejects(client.query('select pg_sleep(1)'), { code:'57014' }); await client.query('rollback');
    await client.query('begin'); await client.query("update filesvc.departments set name='Uncommitted' where id=$1",[dept]);
    const second = await pool.connect();
    try { await second.query('begin'); await second.query("set local lock_timeout='20ms'"); await assert.rejects(second.query('update filesvc.departments set name=name where id=$1',[dept]),{code:'55P03'}); await second.query('rollback'); }
    finally { second.release(); }
    const { recordAudit } = load('src/infrastructure/audit/record-audit.ts');
    await assert.rejects(recordAudit({tenantId:tenant,applicationId:app,keyId},{action:'fixture.audit',outcome:'success',details:{signedUrl:'https://fixture.invalid/?token=x'}},client));
    await client.query('rollback');
    assert.equal((await client.query('select name from filesvc.departments where id=$1',[dept])).rows[0].name,'Security');
  } finally { client.release(); }
});
test('every public v1 route uses the shared audit/security wrapper', () => {
  function walk(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(entry => entry.isDirectory() ? walk(path.join(dir,entry.name)) : entry.name==='route.ts' ? [path.join(dir,entry.name)] : []); }
  for (const file of walk('src/app/api/v1')) {
    const source=readFileSync(file,'utf8'); assert.ok(source.includes('auditRoute('),file);
    for (const match of source.matchAll(/export const (GET|POST|PATCH|DELETE|PUT)\s*=/g)) assert.match(source.slice(match.index),new RegExp(`^export const ${match[1]}\\s*=\\s*auditRoute\\(`),file);
  }
});
test('API pool awaits session timeout initialization before the first query', async () => {
  const { getDatabasePool } = load('src/infrastructure/database/pool.ts');
  const apiPool = getDatabasePool();
  try {
    const client = await apiPool.connect();
    try {
      assert.equal((await client.query('show statement_timeout')).rows[0].statement_timeout,'15s');
      assert.equal((await client.query('show lock_timeout')).rows[0].lock_timeout,'5s');
    } finally { client.release(); }
  } finally { await apiPool.end(); delete globalThis.fileStoragePool; }
});
