# File Storage API

## Department quota rollout — backfill and reconciliation

New uploads (including batch), version uploads and version restores now reserve bytes and settle actual stored bytes in the same database transaction as their file/version changes and audit records. Completed retries do not charge twice. Requests denied for capacity return `409 department_quota_exceeded`; batch requests preserve the existing partial-success format with a per-file error code.

The caller must supply the correct file size. Actual bytes above the reservation are charged as observed but quarantined with `409 upload_size_exceeds_reservation`; the previous current version remains selected. Per-file size violations still return `413 file_too_large`. Failed restore reservations and rejected objects stay `release_pending` until the cleanup worker confirms object deletion or absence; a failed/expired operation does not automatically return quota.

Cleanup and permanent-purge workers now release used/reserved bytes only after Storage removal succeeds. Allocation release, counters, job completion and audit records commit together. Retries cannot release the same allocation twice. Moving a file to trash and restoring it do not release or reserve space. Permanent purge verifies removal of every version and outstanding allocation before releasing the file's accounting; it waits for outstanding upload/restore grants to expire first.

Changing a file's department through the metadata endpoint transfers all outstanding allocations, including historical versions and pending upload/restore reservations. The destination must have capacity for both used and reserved bytes; otherwise the entire move returns `409 department_quota_exceeded` without changing the file. Transfers and worker releases lock the parent file and quota rows consistently, including a move while Storage removal is in progress. Object keys stay unchanged, and previously released allocation history retains its original department. If an initialized quota is involved but historical objects lack allocations, the move fails with `503 quota_accounting_not_ready` until backfill covers them.

The initial backfill on 2026-11-02 verified all three existing departments against Storage and initialized their accounting. Limits remain unlimited (`limit_bytes=NULL`) until a Tenant Admin changes them. Newly created or unverified departments still return `pending_backfill` with unknown totals. A finite limit on uninitialized accounting fails closed with `503 quota_accounting_not_ready`. The **พื้นที่จัดเก็บ** screen and quota endpoints below provide scoped usage and limit management. Restart the API and outbox worker after installing these changes; this step needs no additional migration.

This step does not enforce a physical hard cap on direct signed uploads; publication is validated at complete, and bucket limits plus cleanup still apply.

```powershell
node --env-file=.env.local scripts/check-quota-uploads.mjs
node --env-file=.env.local scripts/check-quota-worker-transfers.mjs
node --env-file=.env.local scripts/check-object-cleanup.mjs
node --env-file=.env.local scripts/check-quota-reconciliation.mjs
```

The checks use PostgreSQL TEMP tables and simulated Storage/Auth, plus a brief two-connection quota-lock check with all writes rolled back. They cover destination capacity, permissions, audit rollback, transfer during deletion, cleanup retries and purge receipts. No real Storage objects are created.

### Backfill and reconciliation commands

Both commands default to report-only: they inspect SQL and Storage but do not change database rows or Storage objects. They save a JSON report in `.quota-reports/` (ignored by Git) containing identifiers, object keys, decimal byte totals and issue codes; never credentials, tokens, signed URLs, file contents or user emails. Treat these operational reports as private.

```powershell
npm.cmd run quota:backfill
npm.cmd run quota:reconcile
npm.cmd run quota:backfill -- --tenant-id <TENANT_UUID> --application-id <APPLICATION_UUID> --department-id <DEPARTMENT_UUID>
npm.cmd run quota:backfill -- --apply
npm.cmd run quota:reconcile -- --apply
```

With no tenant/application filters, exactly one active application must exist. `--department-id` is optional; inventory still covers the whole application so an unowned object cannot be silently attributed to another department. The scripts use the dedicated `DATABASE_URL` login and server-side Storage credentials; they reject the `postgres` login and need no additional grants.

Backfill deduplicates file/current-version references by `(bucket_id, object_key)`, includes every historical version and recoverable trash, and verifies object sizes using Storage API `info`. It scans the configured `STORAGE_BUCKET` plus buckets referenced by files in the selected application, with recursive pagination. Buckets outside that managed set are not covered. Missing allocations are created without changing files, versions, keys or objects. Available objects become `stored`; live pending intents retain reservations even if bytes are already present. Failed operations keep their existing debt, or acquire conservative `release_pending` accounting, until cleanup confirms removal. Confirmed purged/cleaned objects retain zero-balance `released` history. Expiry alone never releases quota.

Reconciliation compares references, allocations, counters and Storage. Missing/size-mismatched objects, wrong allocation ownership, invalid paths, incomplete inventory and orphan objects block the affected department. An object whose department cannot be identified blocks the selected application. No object is deleted and no file metadata is repaired automatically. `reconcile --apply` only repairs totals/initialization when the ledger is complete and verified; use backfill to add missing allocations. Counter drift alone is repairable. Already initialized departments retain their prior status on inspection failure; the report must still be resolved before relying on their totals.

### Maintenance and applying a report

1. Restart **every** API and worker instance with the new code before the first apply. Do not run old workers, direct SQL writers or dashboard Storage mutations during maintenance.
2. `--apply` creates `.quota-reports/maintenance.lock`, immediately blocks new file/folder/department mutations with `503 storage_maintenance` and `Retry-After: 60`, and waits up to two minutes for registered in-flight API/worker work to finish. Search, metadata reads, preview/download grants, login and audit reads remain usable. The worker pauses cleanup/purge without consuming new jobs; audit retention can continue.
3. Storage is inspected outside transactions. Before each department commits, the script rechecks SQL/Storage snapshots, locks parent files before quota rows and validates the snapshot again. It inserts missing allocations, updates counters and `initialized_at`, and writes Audit atomically. A failed department rolls back; previously committed departments remain valid. A repeat apply with no changes is a no-op.
4. The script releases its maintenance lock in `finally`, including errors. Rerun report-only reconciliation afterwards. Exit code `0` means inspection/apply completed, `2` means departments were blocked or failed, and `1` means a command/configuration failure. Do not turn on finite limits until the relevant department passes reconciliation.

The automatic lock and active-request leases are filesystem based, shared by API, worker and CLI in this local project. `STORAGE_QUOTA_CONTROL_DIR` can select an absolute shared control/report directory; all processes must use the same location. On multiple hosts, put **all** instances into maintenance and drain them before applying; a local lock cannot pause a remote instance. `STORAGE_QUOTA_MAINTENANCE=1` also blocks mutations/worker deletion, but changing that environment variable requires restarting existing processes. Remove the flag and restart them to resume.

Previously issued signed upload URLs can still upload directly during maintenance. Pending allocations stay reserved; completion and cleanup resume afterwards. Never infer that bytes are gone from an expired grant alone. After an abnormal termination, the lock deliberately remains fail-closed: inspect its PID/owner, confirm that process and in-flight work have stopped, then remove only the stale `maintenance.lock` and rerun. Live-process leases are never expired automatically; crashed-process leases are removed on the next maintenance acquisition.

Initial applied totals (2026-11-02; subsequent file operations change them): BA `265476` bytes, IT `321751` bytes, General `1145002` bytes; reservations were zero in each department. Reports record each run and transactional audit events use `storage.quota_backfilled` / `storage.quota_reconciled`. Reconciliation is not scheduled automatically, and neither backfill nor reconciliation is exposed through the web UI.

### Storage quota API and screen

Open **พื้นที่จัดเก็บ** from the desktop sidebar or **พื้นที่** from mobile navigation. Its department filter is independent of the file/folder workspace. Desktop tables and mobile cards show used bytes, reserved bytes, limit, available capacity and last refresh time. Used space includes every retained version and recoverable trash; it is returned only after the worker confirms physical deletion. Pending backfill values are unknown (`null`), not zero. An unlimited limit has no artificial percentage. Finite status uses used + reserved: normal, near full at 80%, full at the limit, and over quota above it.

| Caller | Read usage | Set limits |
|---|---|---|
| Tenant Admin signed in through Supabase Auth | Every active department in their tenant/application | Yes |
| Department Admin / Editor | Their Editor/Admin departments | No |
| API key with `files:read` | Its Editor/Admin departments | No, including management keys |
| Viewer | No quota items; menu hidden | No |

`GET /api/v1/departments/storage-quotas` requires a valid session/API key and `files:read`. It returns `{ "data": { "items": [...] } }`, using one scoped query. Each item includes `departmentId`, `departmentName`, `accountingStatus`, `limitBytes`, `usedBytes`, `reservedBytes`, `committedBytes`, `availableBytes`, `overQuota`, `revision` and `canManageQuota`. Bytes/revision are decimal strings. A Viewer-only identity receives an empty item list; missing read scope receives `403`. No request parameter can override the identity's tenant/application.

`PATCH /api/v1/departments/{departmentId}/storage-quota` accepts only a Tenant Admin **user session**, with this JSON body:

```json
{
  "limitBytes": "10000000000",
  "expectedRevision": "12"
}
```

Use the latest `revision` returned by GET, not the example number. `limitBytes: null` removes the cap; `"0"` is a valid finite cap when committed bytes are zero. Values must be canonical non-negative PostgreSQL bigint strings (`0` through `9223372036854775807`); numeric JSON values, fractions, negative values, exponent notation and unknown body fields receive `400`. Success returns `{ "data": <updated quota item> }`. All responses use `Cache-Control: no-store`.

The setter locks only the quota row, reads the latest revision and used/reserved bytes, and commits the limit, incremented revision and `department.quota_update` audit together. Audit contains previous/new limits and the current balances; no credentials. An unchanged value is a no-op after checking revision/readiness. Limits cannot be set below used + reserved, and finite limits require initialized accounting. Existing files are never deleted to meet a cap. Upload/restore reservations, moves and worker releases update revision too, so even a usage change can invalidate a form opened earlier.

| Error | Meaning / recovery |
|---|---|
| `401 unauthorized` | Sign in again or supply a valid key for reads. |
| `403 department_quota_forbidden` | The caller lacks read scope/department access or is not a Tenant Admin user for writes. |
| `404 department_quota_not_found` | The department is inactive, absent or outside the caller's tenant/application. |
| `409 quota_revision_conflict` | Reload the latest values, review the retained input and save again. `error.details.revision` contains the latest revision. |
| `409 quota_limit_below_committed` | Increase the limit or reduce stored bytes first. `error.details.minimumLimitBytes` is the current minimum. |
| `503 quota_accounting_not_ready` | Complete operational backfill/reconciliation before setting a finite cap. Unlimited remains available. |
| `503 storage_maintenance` | Mutations are paused; usage reads remain available. Retry later. |

PowerShell examples (use a Tenant Admin access token only in a trusted local terminal):

```powershell
$headers = @{ Authorization = "Bearer <ADMIN_ACCESS_TOKEN>" }
$quotas = Invoke-RestMethod "http://localhost:3000/api/v1/departments/storage-quotas" -Headers $headers
$quota = $quotas.data.items | Where-Object departmentId -eq "<DEPARTMENT_UUID>"
$body = @{ limitBytes = "10000000000"; expectedRevision = $quota.revision } | ConvertTo-Json
Invoke-RestMethod "http://localhost:3000/api/v1/departments/<DEPARTMENT_UUID>/storage-quota" -Method Patch -Headers $headers -ContentType "application/json" -Body $body
```

The UI offers unlimited or bytes/MB/GB (decimal: 1 MB = 1,000,000 bytes; 1 GB = 1,000,000,000 bytes), validates on blur/submit, preserves exact values with decimal strings/BigInt and previews remaining space. A conflict reloads current values while retaining input; it never automatically resubmits. Refresh occurs on page entry, manually and after saves, without polling. There is no new schema, auth scope, email alert or usage-history chart.

Quota checks:

```powershell
node --env-file=.env.local scripts/check-quota-api.mjs
node --env-file=.env.local scripts/check-quota-api.mjs --live-read
node --env-file=.env.local scripts/check-quota-ui.mjs
```

API writes are tested on TEMP fixtures and rolled back. `--live-read` additionally reads current departments and checks quota-row serialization with a no-op setter under two rollback-only transactions; it does not change real limits. The UI check needs an already running server at `http://localhost:3017` (override with `QUOTA_UI_URL`), installed Chrome (override `QUOTA_UI_BROWSER`) and Playwright (override `PLAYWRIGHT_MODULE`; the local test runtime is `.quota-reports/ui-runtime/node_modules/playwright`). Auth/APIs are mocked. Screenshots in `.quota-reports/ui/` cover 1440px/390px, permissions, validation, conflict/retry, success, empty/error states and dialog keyboard focus. No production account is modified by browser tests.

Next.js App Router API foundation for the shared File Storage Service. The project uses TypeScript, Route Handlers, PostgreSQL via `pg`, and Supabase Storage via `@supabase/supabase-js`.

Invited-user Supabase Auth setup and Tenant Admin bootstrap: [docs/SUPABASE_AUTH_SETUP.md](docs/SUPABASE_AUTH_SETUP.md).

Tenant Admin audit history is available at `GET /api/v1/audit-events` and in the **ประวัติการใช้งาน** screen. Keep `npm.cmd run worker:outbox` running so audit retention executes daily. Set `AUDIT_ALERT_WEBHOOK_URL` to an HTTPS endpoint that accepts JSON to receive retention failure alerts; also monitor the worker log for `Audit retention failed`.

The same worker cleans up tracked incomplete uploads and restore copies every minute (up to 10 objects per cycle), after their intent expires plus a one-hour grace period. It preserves current/available versions and recoverable trash, records durable jobs in `filesvc.object_cleanup_jobs`, and retries failures. Apply migrations and restart the worker when updating; see [cleanup behavior](docs/API_DOCUMENTATION.md#cleanup-ของ-uploadrestore-ที่ค้าง). Logs beginning with `Abandoned object cleanup failed` require monitoring; this job does not send alerts via the audit-retention webhook.

Cleanup verification uses isolated PostgreSQL TEMP tables and simulated Storage:

```powershell
node --env-file=.env.local scripts/check-object-cleanup.mjs
# Also upload/remove one isolated Storage fixture, with cleanup in finally:
node --env-file=.env.local scripts/check-object-cleanup.mjs --storage
```

## Current endpoints

- `GET /api/health/live` — process liveness; does not require credentials.
- `GET /api/health/ready` — checks PostgreSQL connectivity and returns `503` until `DATABASE_URL` is configured and reachable.

## Local development

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:3000/api/health/live` to check the process. Do not place real credentials in `.env.example`; `.env.local` is ignored by Git.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string for the Supabase project. Use a dedicated login principal that is a member of `filesvc_api`; do not use the `postgres` superuser. |
| `WORKER_DATABASE_URL` | Separate PostgreSQL connection string for a login principal that is a member of `filesvc_worker`; used only by the outbox worker. |
| `SUPABASE_URL` | Supabase project URL for server-side Storage operations. |
| `SUPABASE_SECRET_KEY` | Server-only Supabase secret key. Never expose it through a `NEXT_PUBLIC_` variable or send it to clients. |
| `STORAGE_BUCKET` | Private Storage bucket name; currently `private-files`. |
| `MAX_UPLOAD_SIZE_BYTES` | API metadata validation limit; defaults to 25 MiB. Set the bucket's maximum file size in Supabase Storage to the same value because signed upload URLs upload directly to Storage. |

Get the PostgreSQL connection string from Supabase Dashboard → Connect. Use the connection mode supported by the local network. Keep all credentials in local environment secrets or the deployment platform's secret variables.

## Structure

```text
src/
  app/api/health/       liveness and readiness routes
  application/files/    ports used by application use cases
  domain/files/         file lifecycle model
  infrastructure/
    database/           PostgreSQL pool and Dapper-style SQL repository
    storage/            Supabase Storage adapter
```

File access is scoped by tenant, application, department role, and file status. Invited users see documents shared within their authorized departments; trusted server-to-server API key callers retain the owner-subject filter.

## Development notes

- This is an API foundation; Railway deployment and credentials are intentionally not configured.
- The app uses the Node.js runtime for database and Storage integrations.
- The workspace is now using Node `24.22.1` (npm `11.19.1`), matching the project version in `.nvmrc`.
- Next.js Route Handlers live under `src/app` and use Web `Request`/`Response` APIs.

## Create an application API key

Create keys from a trusted local terminal for initial setup or recovery. The script generates a random secret, stores only its SHA-256 hash in `filesvc.application_keys`, and prints the full key once. It defaults to a 90-day expiry; set a different period between 1 and 365 days with `--expires-in-days`. Valid scopes are `files:read`, `files:write`, and `keys:manage`.

```powershell
npm.cmd run key:create -- --application-id <APPLICATION_UUID> --scopes files:read,files:write,keys:manage
```

Use the `application_id` returned when creating the application. This management key is needed to administer keys through the API. Store it in a password manager or a server-side secret store. Do not commit it, put it in a `NEXT_PUBLIC_` variable, or paste it into logs or chat. The key can be validated at `GET /api/v1/me`.

## Manage application API keys

All key-management endpoints require `Authorization: Bearer <MANAGEMENT_API_KEY>` with the `keys:manage` scope. A management key can list keys for its own application, issue keys with file scopes, and revoke other keys for that same application. API-issued keys cannot receive `keys:manage`; create or recover a management key from a trusted terminal.

- `GET /api/v1/keys` — list key metadata (prefix, scopes, dates, last use, and revoke status). The secret and hash are never returned.
- `POST /api/v1/keys` — create a key. Defaults to 90 days and `files:read`; `expiresInDays` must be 1–365 and `scopes` may contain unique `files:read` and/or `files:write` values. The secret is returned once.
- `DELETE /api/v1/keys/{keyId}` — revoke a key. A key cannot revoke itself; use a different management key to avoid locking out key administration.

Example request body:

```json
{
  "expiresInDays": 90,
  "scopes": ["files:read", "files:write"]
}
```

New key secrets are displayed only in the create response and cannot be retrieved later. Store them securely. All key-management responses disable caching.

## Application key authentication

- `GET /api/v1/me` validates `Authorization: Bearer <API_KEY>` and returns the authenticated tenant, application, and granted scopes.
- Browser requests use a Supabase Auth access token instead. The API verifies it and loads active tenant membership and department roles; uploads derive `owner_subject` from the verified user ID. See [Auth setup](docs/SUPABASE_AUTH_SETUP.md).
- Invalid, expired, revoked, or inactive keys receive the same `401` response. Database failures return `503` without exposing connection details.
- The authentication query derives tenant and application identity from the key row; it never trusts tenant or application IDs from caller-supplied headers or request bodies.
- API keys are server-to-server credentials. Do not place them in browser code or `NEXT_PUBLIC_` variables. A browser app should call its own backend, which then calls this service.
- `POST /api/v1/files/upload-intents` requires `files:write`; it records a `pending_upload` file and upload intent, then returns a short-lived Storage upload grant. The caller supplies `ownerSubject` from its own authenticated-user context; tenant and application IDs always come from the API key.
- `POST /api/v1/files/{fileId}/complete` verifies that the object exists, checks its actual size against the configured limit, and changes its state to `available`. Oversized uploads are quarantined and removed where possible.
- `POST /api/v1/files/{fileId}/download-url` requires `files:read` and an `ownerSubject`; it returns a five-minute signed URL only when the file belongs to the key's tenant/application and that owner.
- `POST /api/v1/files/search` requires `files:read` and an `ownerSubject`; it returns available file metadata with cursor pagination, without exposing Storage object paths.
- `POST /api/v1/files/{fileId}/delete` requires `files:write` and Editor/Admin role; it moves an available file to trash while retaining the Storage object. It returns `200` with `trashed: true`.
- `GET /api/v1/files/trash` lists trashed files with cursor pagination. `POST /api/v1/files/{fileId}/restore` checks that the Storage object still exists before restoring an Editor/Admin-accessible file.
- `POST /api/v1/files/{fileId}/purge` requires Admin role; it atomically queues permanent deletion in `filesvc.outbox` and returns `202`.
- The outbox worker reads `file.object_delete_requested`, removes the Storage object idempotently, marks the file `deleted`, and marks the event processed. Failed events are retried with capped exponential backoff.

## Run the outbox worker locally

Create a dedicated login role as a database administrator. The existing `filesvc_worker` group role already has the required read/update grants and RLS policies; do not run the worker with the API login or `postgres`:

```sql
create role filesvc_worker_runtime login in role filesvc_worker;
```

Set its password securely in `psql` with `\password filesvc_worker_runtime`, then add a `WORKER_DATABASE_URL` for that login to `.env.local`. For Supabase Session Pooler, use the pooler host/port and the username format shown by the Dashboard, typically `filesvc_worker_runtime.<project-ref>`. Keep `SUPABASE_SECRET_KEY` server-side; the worker needs it to remove objects.

Run the worker in a second terminal:

```powershell
npm.cmd run worker:outbox
```

It polls the outbox until stopped with `Ctrl+C`. After the worker is running, a `202` from the purge endpoint means the event is queued; the worker then removes the object and changes the file status to `deleted`.
- Upload tokens and signed URLs are bearer capabilities. Treat the response as a secret and do not log it. The current private bucket has no per-bucket size limit configured; set one in the Supabase Dashboard to match `MAX_UPLOAD_SIZE_BYTES` before relying on the API size check in production.
