# File Storage API

Next.js App Router API foundation for the shared File Storage Service. The project uses TypeScript, Route Handlers, PostgreSQL via `pg`, and Supabase Storage via `@supabase/supabase-js`.

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

The repository example filters by file id, tenant, application, owner, and `available` status. Authentication and the upload-intent use case are not wired yet; callers must derive the scope from verified credentials, never from untrusted request fields.

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
- Invalid, expired, revoked, or inactive keys receive the same `401` response. Database failures return `503` without exposing connection details.
- The authentication query derives tenant and application identity from the key row; it never trusts tenant or application IDs from caller-supplied headers or request bodies.
- API keys are server-to-server credentials. Do not place them in browser code or `NEXT_PUBLIC_` variables. A browser app should call its own backend, which then calls this service.
- `POST /api/v1/files/upload-intents` requires `files:write`; it records a `pending_upload` file and upload intent, then returns a short-lived Storage upload grant. The caller supplies `ownerSubject` from its own authenticated-user context; tenant and application IDs always come from the API key.
- `POST /api/v1/files/{fileId}/complete` verifies that the object exists, checks its actual size against the configured limit, and changes its state to `available`. Oversized uploads are quarantined and removed where possible.
- `POST /api/v1/files/{fileId}/download-url` requires `files:read` and an `ownerSubject`; it returns a five-minute signed URL only when the file belongs to the key's tenant/application and that owner.
- `POST /api/v1/files/search` requires `files:read` and an `ownerSubject`; it returns available file metadata with cursor pagination, without exposing Storage object paths.
- `POST /api/v1/files/{fileId}/delete` requires `files:write`; it atomically marks an available file as `deleting` and enqueues `file.object_delete_requested` in `filesvc.outbox`. It returns `202`; a worker must remove the Storage object and set the final status to `deleted`.
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

It polls the outbox until stopped with `Ctrl+C`. After the worker is running, a `202` from the delete endpoint means the event is queued; the worker then removes the object and changes the file status to `deleted`.
- Upload tokens and signed URLs are bearer capabilities. Treat the response as a secret and do not log it. The current private bucket has no per-bucket size limit configured; set one in the Supabase Dashboard to match `MAX_UPLOAD_SIZE_BYTES` before relying on the API size check in production.
