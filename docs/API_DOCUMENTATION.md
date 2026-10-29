# File Storage Service API

เอกสาร API ที่มีอยู่ในโครงการ ณ ปัจจุบัน ครอบคลุม health check, API key, หน่วยงาน, โฟลเดอร์ และการจัดการไฟล์

## Base URL และ Authentication

| Environment | Base URL |
|---|---|
| Local | `http://localhost:3000` |
| Production | URL ของ deployment |

ทุก endpoint ยกเว้น health checks ต้องส่ง API key:

```http
Authorization: Bearer <API_KEY>
```

API key เป็น secret สำหรับ server-to-server ห้ามใส่ใน browser, `NEXT_PUBLIC_` variables, source control หรือ logs; signed URLs และ response จากการสร้าง key ก็เป็นข้อมูลลับ

### Scopes และบทบาท

| Scope | สิทธิ์หลัก |
|---|---|
| `files:read` | ตรวจตัวตน, ดูหน่วยงาน/โฟลเดอร์ที่เข้าถึงได้, ค้นหา, ขอ preview/download URL |
| `files:write` | สร้างโฟลเดอร์, ขอ upload intent, complete upload, แก้ metadata, ขอ delete |
| `keys:manage` | ดู, สร้าง และเพิกถอน API keys ในขอบเขตหน่วยงานที่ key เป็น Admin |
| `departments:manage` | ผู้ดูแลระดับ application: เห็นทุกหน่วยงานและสร้างหน่วยงาน; ออกให้จาก trusted setup เท่านั้น ไม่สามารถส่งต่อผ่าน API |

บทบาท `Admin`, `Editor`, `Viewer` ผูกกับ API key ต่อหน่วยงาน: Admin จัดการ key ในหน่วยงานได้เมื่อมี `keys:manage`; Editor อ่านและแก้ไขไฟล์; Viewer อ่านและดาวน์โหลดได้เท่านั้น การมี `keys:manage` ไม่ได้ทำให้เป็น application admin และ key ที่ไม่มี department grant จะเข้าถึงไฟล์ไม่ได้ บทบาทเหล่านี้ยังไม่ใช่ตัวตนผู้ใช้ SSO

## รูปแบบ response ทั่วไป

- Error: `{ "error": { "code": "...", "message": "..." } }`
- ข้อมูลที่มี secret หรือ signed URL ส่งกลับพร้อม `Cache-Control: no-store`
- `401`: key ไม่มี/ไม่ถูกต้อง/หมดอายุ/revoked หรือ application ไม่ active
- `403`: ไม่มี scope หรือบทบาทที่จำเป็น
- `503`: บริการหรือฐานข้อมูลที่ต้องพึ่งพาไม่พร้อม
- ค่าเวลา `timestamptz` ใน API ส่งเป็น ISO 8601 UTC (`Z`) เพื่อให้ client แปลงได้ถูกต้อง; หน้าเว็บแสดงเวลาเป็น `Asia/Bangkok` (UTC+07:00)
- PostgreSQL role `filesvc_runtime` และ `filesvc_worker` ตั้ง session timezone เป็น `Asia/Bangkok`; การตั้งค่าใหม่มีผลเมื่อเชื่อมต่อฐานข้อมูลใหม่ หากใช้ SQL Editor ด้วย role `postgres` ให้รัน `SET TIME ZONE 'Asia/Bangkok';` ใน session นั้นเพื่อดูค่า `timestamptz` เป็นเวลาไทย

## Health checks (ไม่ต้องใช้ key)

### `GET /api/health/live`

ตรวจว่า API process ตอบสนองหรือไม่; `200` คืน `{ "status": "ok", "service": "file-storage-api", "timestamp": "..." }`

### `GET /api/health/ready`

ตรวจการเชื่อมต่อ PostgreSQL; คืน `200` พร้อม `{ "status": "ready", "checks": { "database": "ok" } }` หรือ `503` พร้อมสถานะ `not_ready`

## Identity

### `GET /api/v1/me`

ตรวจ key ปัจจุบัน; ต้องใช้ key ที่ถูกต้อง

ตัวอย่าง `200`:

```json
{
  "authenticated": true,
  "tenantId": "<TENANT_UUID>",
  "applicationId": "<APPLICATION_UUID>",
  "scopes": ["files:read", "files:write"],
  "departments": [
    { "id": "<DEPARTMENT_UUID>", "code": "dept-example", "name": "Example", "role": "editor" }
  ]
}
```

## API key management

ทุก endpoint ต้องใช้ `keys:manage`; key ที่มีสิทธิ์จัดการได้เฉพาะหน่วยงานที่ตนเป็น Admin ส่วน `departments:manage` เข้าถึงทุกหน่วยงานได้

### `GET /api/v1/keys`

แสดง metadata ของ keys ที่อยู่ในขอบเขตจัดการ ไม่คืน secret หรือ hash

Response `200`: `data.items[]` มี `id`, `keyPrefix`, `scopes`, `createdAt`, `expiresAt`, `revokedAt`, `lastUsedAt` และ `departmentGrants[]` (id/code/name/role)

### `POST /api/v1/keys`

สร้าง key; ทุก grant ต้องเป็นหน่วยงานที่ผู้เรียกมีสิทธิ์มอบบทบาทนั้น

Request:

```json
{
  "expiresInDays": 90,
  "scopes": ["files:read", "files:write"],
  "departmentGrants": [
    { "departmentId": "<DEPARTMENT_UUID>", "role": "editor" }
  ]
}
```

- `expiresInDays`: จำนวนเต็ม 1–365, default 90
- `scopes`: ค่าไม่ซ้ำจาก `files:read`, `files:write`, `keys:manage`; default `files:read`
- `departmentGrants`: required, 1–100 grants; role คือ `admin`, `editor` หรือ `viewer`; ห้ามระบุ department ซ้ำ
- หากขอ `keys:manage` ทุก department grant ต้องเป็น `admin`
- `departments:manage` มอบให้ผ่าน endpoint นี้ไม่ได้

เมื่อสร้างสำเร็จคืน `201`; `data.apiKey` ปรากฏครั้งเดียว ให้เก็บทันที ตัวอย่าง response มี `id`, `keyPrefix`, `scopes`, `departmentGrants`, timestamps, `apiKey` และ `warning`

### `DELETE /api/v1/keys/{keyId}`

เพิกถอน key ในขอบเขตหน่วยงานที่ caller เป็น Admin; รับ `keyId` เป็น UUID ไม่มี request body

- `200`: คืน `data.id` และ `data.revokedAt`
- `400 invalid_key_id`: ID ไม่ใช่ UUID
- `404 key_not_found`: ไม่พบ key ในขอบเขตจัดการ
- `409 cannot_revoke_current_key`: ห้ามเพิกถอน key ที่ใช้เรียก API อยู่ ให้ใช้ management key ตัวอื่น

## Department workspaces

### `GET /api/v1/departments`

ต้องมี `files:read` หรือ `keys:manage`; คืน `data.items[]` เฉพาะหน่วยงานที่ key เข้าถึงได้พร้อม role; application admin ที่มี `departments:manage` เห็นทุกหน่วยงาน

### `POST /api/v1/departments`

สร้างหน่วยงาน ต้องใช้ application admin key ที่มี `departments:manage` และ `Content-Type: application/json`

```json
{ "name": "Finance" }
```

ชื่อยาว 1–160 ตัวอักษร; สำเร็จคืน `201` พร้อม `id`, `code`, `name`, `status`, `createdAt`; ชื่อซ้ำคืน `409 department_name_conflict`

## Folders

### `GET /api/v1/folders?departmentId=<UUID>&parentFolderId=<UUID>`

ต้องมี `files:read` และ role Viewer ขึ้นไปในหน่วยงาน `departmentId` ซึ่งเป็น required query parameter หากไม่ส่ง `parentFolderId` หรือส่งค่าว่างจะแสดง root folders; หากส่ง UUID จะแสดงลูกของ folder นั้น

คืน `200` พร้อม `data.items[]` ซึ่งมี `id`, `name`, `parentFolderId`, `createdAt`, `updatedAt`

### `POST /api/v1/folders`

ต้องมี `files:write` และ Editor/Admin ในหน่วยงานเป้าหมาย

```json
{
  "name": "Contracts",
  "departmentId": "<DEPARTMENT_UUID>",
  "parentFolderId": null
}
```

`parentFolderId` เป็น UUID ของ parent ในหน่วยงานเดียวกัน หรือ `null`/ไม่ส่งเพื่อสร้างที่ root; ชื่อต้องยาว 1–160 ตัวอักษรและไม่มี path separator; ซ้ำใน parent/dept เดียวกันคืน `409 folder_name_conflict`

## Files

### `POST /api/v1/files/upload-intents`

สร้าง upload intent; ต้องมี `files:write` และ Editor/Admin ในหน่วยงานเป้าหมาย

```json
{
  "ownerSubject": "user-123",
  "departmentId": "<DEPARTMENT_UUID>",
  "originalName": "sample.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 53693,
  "checksumSha256": "<OPTIONAL_64_CHARACTER_SHA256_HEX>"
}
```

- `ownerSubject`: required, 1–255 ตัวอักษร
- `departmentId`: required เว้นแต่ key มีสิทธิ์ Editor/Admin ในหน่วยงานเดียวเท่านั้น
- `originalName`: required, 1–1024 ตัวอักษร; `contentType`: required MIME type
- `sizeBytes`: required จำนวนเต็มบวก ไม่เกิน `MAX_UPLOAD_SIZE_BYTES` (default 25 MiB)
- `checksumSha256`: optional SHA-256 hex 64 ตัว

คืน `201` พร้อม `data.fileId`, `bucketId`, `objectKey`, `signedUrl`, `uploadToken`, `expiresAt`; upload grant มีอายุ 2 ชั่วโมง

### `POST /api/v1/files/upload-intents/batch`

ขอ upload intents หลายไฟล์ในคำขอเดียว ต้องมี `files:write` และ Editor/Admin ในหน่วยงานปลายทาง; `ownerSubject` และ `departmentId` ใช้ร่วมกันทุกไฟล์

```json
{
  "ownerSubject": "user-123",
  "departmentId": "<DEPARTMENT_UUID>",
  "files": [
    { "originalName": "one.pdf", "contentType": "application/pdf", "sizeBytes": 53693 },
    { "originalName": "two.pdf", "contentType": "application/pdf", "sizeBytes": 12345 }
  ]
}
```

ส่งได้ 1–20 ไฟล์ต่อคำขอ และใช้ข้อกำหนดชื่อ, MIME type, ขนาด และ `checksumSha256` (optional) เหมือน endpoint รายไฟล์; request JSON จำกัด 64 KiB ระบบคืน `200` พร้อม `data.items[]` ตามลำดับ input โดยแต่ละรายการมี `index`, `status: "ready"` และข้อมูล upload grant หรือ `status: "error"` พร้อม `error.code`/`error.message`; มี `readyCount` และ `errorCount` รวมด้วย หากไฟล์หนึ่งไม่ผ่าน validation หรือสร้าง intent ไม่สำเร็จ ไฟล์อื่นยังดำเนินการต่อ

สำหรับรายการ `ready` ให้ PUT ไฟล์ตาม `index` ไปยัง `signedUrl` ของรายการนั้น แล้วเรียก `POST /api/v1/files/{fileId}/complete` แยกแต่ละไฟล์ หน้าเว็บแบ่งคำขอเป็นชุดละ 20 และอัปโหลดพร้อมกันสูงสุด 3 ไฟล์ พร้อมแสดงผลรายไฟล์

### Upload bytes to Supabase Storage

ส่ง PUT ไปยัง `signedUrl` ที่ได้ ไม่ใช่ API server; ใน Postman ให้เลือก Body → **binary**:

```http
PUT <SIGNED_UPLOAD_URL>
Content-Type: <CONTENT_TYPE>
```

### `POST /api/v1/files/{fileId}/complete`

ยืนยัน upload; ต้องมี `files:write` และ Editor/Admin ของหน่วยงานไฟล์ ไม่ต้องส่ง body

- `200`: `data` มี `fileId`, `status`, `sizeBytes`, `contentType`; หากเรียกซ้ำหลัง complete แล้วอาจคืนเพียง `fileId` และ `status`
- API ตรวจ object และขนาดจริงก่อนกำหนดสถานะ available
- intent หมดอายุคืน `410 upload_intent_expired`; object ยังไม่พบคืน `409 object_not_found`

### `POST /api/v1/files/search`

ค้นไฟล์ของ `ownerSubject`; ต้องมี `files:read`

```json
{
  "ownerSubject": "user-123",
  "departmentId": "<OPTIONAL_DEPARTMENT_UUID>",
  "folderId": "<OPTIONAL_FOLDER_UUID>",
  "tag": "contract",
  "contentType": "application/pdf",
  "createdFrom": "2026-10-01",
  "createdTo": "2026-10-29",
  "limit": 25,
  "cursor": null
}
```

`ownerSubject` required 1–255 ตัวอักษร; `departmentId`, `folderId`, `tag`, `contentType`, `createdFrom`, `createdTo` optional; `contentType` กรอง MIME type แบบตรงค่าโดยไม่สนตัวพิมพ์เล็ก/ใหญ่; วันที่ต้องเป็น `YYYY-MM-DD` ตาม `Asia/Bangkok` โดยรวมวัน `createdTo` ทั้งวัน (00:00 ถึงก่อน 00:00 ของวันถัดไป); ส่งวันเดียวได้ และ `createdFrom` ต้องไม่เกิน `createdTo`; ไม่ระบุ department จะค้นในทุก department ที่ key เข้าถึงได้; `limit` 1–100 (default 25); `cursor` ใช้ค่าจาก response ก่อนหน้า

คืน `200` พร้อม `data.items[]` (id, fileName, contentType, sizeBytes, status, createdAt และข้อมูล metadata ที่มี) และ `nextCursor` ซึ่งเป็น `null` เมื่อไม่มีหน้าถัดไป

### `PATCH /api/v1/files/{fileId}/metadata`

แก้ metadata หรือย้ายไฟล์ที่ available; ต้องมี `files:write`, `ownerSubject` และ Editor/Admin ในหน่วยงานปัจจุบัน; การย้ายข้ามหน่วยงานต้องมี Editor/Admin ในหน่วยงานปลายทางด้วย

```json
{
  "ownerSubject": "user-123",
  "displayName": "Signed contract",
  "tags": ["contract", "signed"]
}
```

ส่งเฉพาะ fields ที่แก้: `displayName` (1–255 ตัวอักษร), `tags` (ไม่เกิน 50 strings; ส่ง `[]` เพื่อล้าง), `folderId` (UUID หรือ `null` เพื่อย้าย root), `departmentId` (UUID ของหน่วยงานปลายทาง) หากเปลี่ยน `departmentId` แต่ไม่ส่ง `folderId` ระบบย้ายไฟล์ไป root ของหน่วยงานปลายทาง; folder ที่ระบุต้องอยู่ในหน่วยงานเป้าหมาย

คืน `200` พร้อม metadata ที่อัปเดต; หากไม่พบไฟล์หรือ target folder คืน `404 file_or_folder_not_found`

### `POST /api/v1/files/{fileId}/download-url`

ขอ signed download URL; ต้องมี `files:read` และ body:

```json
{ "ownerSubject": "user-123" }
```

คืน `200` พร้อม `data.fileId`, `fileName`, `contentType`, `sizeBytes`, `signedUrl`, `expiresInSeconds` (ปัจจุบัน 300 วินาที); ใช้ signed URL ดาวน์โหลดโดยตรง

### `POST /api/v1/files/{fileId}/preview-url`

ขอ signed preview URL; ต้องมี `files:read` และ body เดียวกับ download URL รองรับ PDF, JPEG, PNG, GIF, WebP และ plain text; ชนิดอื่นรวม HTML/SVG คืน `415 preview_not_supported`; URL มีอายุ 300 วินาที

### `POST /api/v1/files/{fileId}/delete`

ขอลบไฟล์; ต้องมี `files:write`, Editor/Admin ของหน่วยงาน และ body:

```json
{ "ownerSubject": "user-123" }
```

คืน `200` พร้อม `data.status: "deleted"` และ `data.trashed: true`; ไฟล์จะถูกซ่อนจากการค้นหาปกติ แต่ object ยังคงอยู่ใน Storage เพื่อให้กู้คืนได้

### `GET /api/v1/files/trash?ownerSubject=<OWNER>&departmentId=<UUID>`

ดูไฟล์ในถังขยะ ต้องมี `files:read` และสิทธิ์ Viewer ขึ้นไป; `ownerSubject` เป็น required query parameter และ `departmentId` เป็น optional หากไม่ส่งจะดูทุกหน่วยงานที่ key เข้าถึงได้ คืน `data.items[]` สูงสุด 100 รายการ เรียงจากวันที่ลบล่าสุด โดยมี `trashedAt` ในแต่ละรายการ

### `POST /api/v1/files/{fileId}/restore`

กู้คืนไฟล์จากถังขยะ ต้องมี `files:write` และ Editor/Admin ในหน่วยงานไฟล์ ส่ง body `{ "ownerSubject": "user-123" }`; สำเร็จคืน `200` พร้อม `data.status: "available"`; หากไฟล์ไม่อยู่ในถังขยะหรือไม่มีสิทธิ์คืน `404 file_not_found`

ไฟล์ที่ถูกลบถาวรก่อนเพิ่มฟีเจอร์ถังขยะไม่สามารถกู้คืนผ่าน endpoint นี้ได้ ไฟล์ที่เข้าถังขยะใหม่ยังไม่มีการลบถาวรอัตโนมัติ

## Error codes ที่พบบ่อย

| HTTP | ตัวอย่าง code | ความหมาย |
|---:|---|---|
| 400 | `invalid_json`, `invalid_owner_subject`, `invalid_size`, `invalid_scopes`, `invalid_department_id`, `invalid_folder_id`, `invalid_cursor`, `invalid_content_type`, `invalid_date_range` | รูปแบบหรือค่าที่ส่งไม่ผ่าน validation |
| 401 | `unauthorized` | ไม่มีหรือใช้ API key ไม่ได้ |
| 403 | `forbidden`, `department_forbidden`, `department_grant_forbidden` | ไม่มี scope หรือ role ในหน่วยงาน |
| 404 | `file_not_found`, `key_not_found`, `parent_folder_not_found`, `file_or_folder_not_found` | ไม่พบ resource ในขอบเขตที่เรียกได้ |
| 409 | `upload_not_pending`, `object_not_found`, `folder_name_conflict`, `department_name_conflict`, `cannot_revoke_current_key` | สถานะขัดแย้งหรือทรัพยากรซ้ำ |
| 410 | `upload_intent_expired` | upload intent หมดอายุ |
| 413 | `file_too_large`, `request_too_large` | ไฟล์หรือ request body เกิน limit |
| 415 | `preview_not_supported` | ไม่รองรับ preview content type นี้ |
| 503 | `service_unavailable` | dependency ไม่พร้อมหรือเกิดข้อผิดพลาดชั่วคราว |

## Upload flow

```text
Client -- POST upload-intents + API key --> API
Client <-- fileId + signedUrl + token ---- API
Client -- PUT file bytes to signedUrl ----> Supabase Storage
Client -- POST {fileId}/complete --------> API
API verifies object and marks it available
```

## ข้อจำกัดปัจจุบัน

- Supabase Storage bucket `private-files` เป็น private; ขนาดสูงสุด default 25 MiB ต่อไฟล์
- ยังไม่ได้กำหนด MIME allowlist (`allowed_mime_types = null`) หรือ antivirus scanning
- API key department roles ยังไม่ใช่ SSO/identity รายบุคคล; `ownerSubject` มาจาก request caller
- ยังไม่มี versioning/restore, file sharing, audit trail หรือ quota รวมต่อหน่วยงาน
- ถังขยะรองรับ 100 รายการล่าสุดต่อ request; ยังไม่มี pagination หรือการลบถาวร
