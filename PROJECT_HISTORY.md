# File Storage / DMS Project History

เอกสารนี้สรุปการตัดสินใจ ขั้นตอนพัฒนา และสถานะปัจจุบันของโครงการจากการเริ่มออกแบบ File Storage Service จนถึงการเตรียมขยายเป็น Document Management System (DMS) โดยไม่บันทึก password, API key, token หรือ connection string จริง

## 1. เป้าหมายเริ่มต้น

เริ่มจากแนวคิดสร้างบริการจัดเก็บไฟล์กลางคล้าย MinIO เพื่อให้หลาย Web App ใช้ร่วมกัน โดยมี Supabase และ Railway อยู่แล้ว เป้าหมายหลักคือเก็บไฟล์แบบ private, ให้ API เป็นจุดควบคุมสิทธิ์ และเก็บ metadata ใน PostgreSQL

### แนวทางเดิมที่พิจารณา

- ASP.NET Core Web API
- Clean Architecture, MediatR และ Dapper
- Supabase PostgreSQL และ Supabase Storage
- Deploy API บน Railway

ภายหลังเปลี่ยน backend เป็น Next.js API ตามความต้องการของเจ้าของโครงการ จึงใช้ TypeScript, Next.js App Router, `pg` และ `@supabase/supabase-js` แทน ASP.NET Core และไม่ได้ใช้ EF Core

## 2. โครงสร้างฐานข้อมูลและสิทธิ์

สร้าง schema `filesvc` ในฐานข้อมูล Supabase เดิม ไม่ได้แยก Supabase project หรือสร้าง database แยก ตารางหลักที่ตรวจพบ ได้แก่:

- `tenants` — หน่วยงาน/ผู้เช่า
- `applications` — Web App ที่ใช้บริการภายใต้ tenant
- `application_keys` — metadata, hash, scope, expiry และสถานะ revoke ของ API key
- `files` — metadata และสถานะ lifecycle ของไฟล์
- `upload_intents` — การจอง upload และ fingerprint ของ upload token
- `audit_events` — โครงสร้างบันทึก audit
- `outbox` — งานที่ต้องประมวลผลภายหลัง เช่น ลบ object

เปิด RLS สำหรับตารางใน schema และใช้ database roles แยกหน้าที่:

- `filesvc_api` — สิทธิ์ที่ API ใช้
- `filesvc_worker` — group role สำหรับ outbox worker
- `filesvc_worker_runtime` — login role สำหรับ worker ซึ่งสร้างไว้และเป็นสมาชิกของ `filesvc_worker`

API ใช้ PostgreSQL ผ่าน `DATABASE_URL`; worker ใช้ `WORKER_DATABASE_URL` แยกกัน ไม่ควรใช้ role `postgres` เป็น runtime credential

## 3. การตั้งค่าและเชื่อมต่อในเครื่อง

1. ตั้ง Node.js ในโครงการเป็น `24.22.1` ตาม `.nvmrc`
2. ตั้งค่า `.env.local` สำหรับ PostgreSQL, Supabase URL/secret key, bucket และ upload limit โดยไม่ commit ไฟล์นี้
3. เชื่อม local API กับ Supabase PostgreSQL ผ่าน connection string ที่เหมาะกับ network
4. แก้ปัญหา hostname DNS, URL-encoding ของ password และ authentication failure (`28P01`) ระหว่างตั้งค่า จน readiness endpoint ตอบ `200`
5. เอา `runtime = "nodejs"` ออกจาก route ที่ Next.js ปฏิเสธเมื่อเปิด `cacheComponents`

## 4. API key และการยืนยันตัวตน

เพิ่มสคริปต์ `scripts/create-application-key.mjs` สำหรับสร้าง key ฝั่งเครื่องที่เชื่อถือได้ สร้าง secret แบบสุ่มและเก็บเฉพาะ SHA-256 hash ในฐานข้อมูล โดยแสดง secret ครั้งเดียว

API key มีรูปแบบ prefix และ secret; authentication ตรวจ expiry, revoke, สถานะ tenant/application และ scopes พร้อมบันทึก `last_used_at` เส้น `GET /api/v1/me` ใช้ยืนยัน key และดู tenant/application/scopes

เพิ่ม key management API:

- `GET /api/v1/keys` — ดู metadata ของ keys ภายใต้ application เดียวกัน
- `POST /api/v1/keys` — สร้าง key ที่ใช้ `files:read` และ/หรือ `files:write`; secret แสดงครั้งเดียว
- `DELETE /api/v1/keys/{keyId}` — revoke key; ป้องกัน key ที่กำลังใช้ revoke ตัวเอง

ทุก endpoint การจัดการ key ต้องใช้ scope `keys:manage`; สคริปต์ local รองรับ `--scopes` สำหรับสร้าง management key เริ่มต้นหรือกู้คืนสิทธิ์ เจ้าของโครงการสร้าง management key แล้วและทดสอบการจัดการ key ผ่าน Postman เรียบร้อย

## 5. File API ที่พัฒนาและทดสอบ

### Upload

1. `POST /api/v1/files/upload-intents` — รับ owner, ชื่อไฟล์, MIME และขนาด; สร้าง pending file และคืน signed upload URL
2. `PUT <signedUrl>` — ส่ง bytes จาก client ไปยัง Supabase Storage โดยตรง
3. `POST /api/v1/files/{fileId}/complete` — ตรวจ object/ขนาดจริงและเปลี่ยนสถานะเป็น `available`

ผู้ใช้ทดสอบ upload ด้วย Postman/curl และได้รับสถานะ `available` แล้ว

### Download, search และ delete

- `POST /api/v1/files/{fileId}/download-url` — ออก signed URL อายุสั้นหลังตรวจขอบเขต tenant/application/owner
- `POST /api/v1/files/search` — ค้น metadata แบบ cursor pagination และจำกัดผลลัพธ์ตาม scope/owner
- `POST /api/v1/files/{fileId}/delete` — เปลี่ยนสถานะเป็น `deleting` และ enqueue event ใน `outbox`

ผู้ใช้ทดสอบ download สำเร็จ และได้ response ของ delete request ก่อนที่ worker จะถูกตั้งค่า

## 6. Supabase Storage

- ใช้ bucket `private-files` ซึ่งเป็น private bucket
- ตั้ง `file_size_limit` เป็น `26,214,400` bytes หรือ 25 MiB ให้สอดคล้องกับ API
- `allowed_mime_types` ยังคงเป็น `null` จึงยังไม่ได้จำกัดชนิดไฟล์
- เพิ่ม `scripts/configure-storage-limits.mjs` และคำสั่ง `npm run storage:limits` สำหรับตั้งค่า/ตรวจซ้ำ

## 7. Outbox worker

สร้าง `scripts/process-outbox.mjs` และคำสั่ง `npm run worker:outbox` Worker จะ claim event แบบ `FOR UPDATE SKIP LOCKED`, ตรวจ payload, ลบ object แบบ idempotent, อัปเดต file เป็น `deleted`, mark event processed และ retry เมื่อผิดพลาด

ตั้ง login role `filesvc_worker_runtime`, รหัสผ่าน, `WORKER_DATABASE_URL` ผ่าน Supabase Session pooler และเพิ่ม CA certificate เพื่อใช้ SSL verification หลังพบปัญหา DNS และ certificate chain ระหว่างเชื่อมต่อ

ผู้ใช้รัน worker ในเครื่องและเห็น log `File deletion completed` แล้ว ถือว่าทดสอบการลบผ่าน outbox สำเร็จ

## 8. การตรวจสอบที่ทำ

- ESLint ผ่านหลังเพิ่ม API key management
- TypeScript `tsc --noEmit` ผ่าน
- production build เคยหยุดเพราะ Windows sandbox ปฏิเสธการสร้าง junction ของ Turbopack ใน `.next`; จึงยังไม่ได้ยืนยันผล production build ในสภาพแวดล้อมนี้
- ทดสอบ API หลักและ key management ด้วย Postman ตามที่ผู้ใช้รายงาน
- ทดสอบ worker จนประมวลผล file deletion สำเร็จ

## 9. Requirement Matrix สำหรับ DMS

ผู้ใช้เพิ่ม `MinIO_DMS_Requirement_Matrix.xlsx` และขอให้สรุป requirement พบ 36 ข้อ: Functional 30 ข้อ และ NFR 6 ข้อ แบ่งเป็น P0 22 ข้อ, P1 9 ข้อ และ P2 5 ข้อ

ผู้ใช้เลือกให้เริ่มจาก P0 ก่อน โดย P0 ครอบคลุม:

- SSO/IdP และบทบาท Admin, Editor, Viewer
- แยกคลังตามหน่วยงาน/เจ้าของ และจัดการโฟลเดอร์
- อัปโหลดหลายไฟล์, metadata, validation และ quarantine/virus scanning
- ค้นหา/กรอง, preview และดาวน์โหลดอย่างปลอดภัย
- versioning/restore, sharing/revocation และ trash/restore
- audit trail และ limits/quota ต่อไฟล์/คลัง
- NFR P0: performance, backup/restore, accessibility, MinIO edition/lifecycle, data consistency และ monitoring/alerting

**P0 ยังเหลือหลายส่วน**; ล่าสุดเพิ่ม departmental workspace และการบังคับ role ระดับ API key พร้อม apply migrations `departmental_storage_and_key_grants` และ `separate_department_admin_scope` กับ Supabase ที่เชื่อมอยู่ การเรียงลำดับที่เสนอคือ identity/authorization → secure upload/scanning → search/read/download → version/share/trash → audit/quota

## 10. งานที่ยังไม่เสร็จ

1. สร้าง key แบบ department-scoped สำหรับแต่ละ web app/หน่วยงาน และ revoke key เดิมที่ไม่มี grant หลังยืนยันการใช้งาน
2. กำหนด IdP/SSO ที่องค์กรจะใช้ และ mapping identity/department/group เข้ากับ authorization model
3. เลือกแนวทาง antivirus scanning/quarantine และตั้ง SLA/ข้อจำกัดไฟล์ให้ชัด
4. ทำ quota reservation ที่รองรับ concurrent upload และ quota ต่อคลัง
5. เติม audit trail แบบ append-only และ monitoring/alerts/reconciliation
6. ทดสอบ performance, backup/restore และ accessibility ตาม acceptance criteria
7. Deploy API และ worker แยกเป็น services บน Railway และทดสอบ end-to-end หลัง deploy
8. กำหนด MIME allowlist ของ Storage (ปัจจุบันยังไม่จำกัด)

### Departmental workspace implementation (2026-10-28)

- เพิ่ม departments, department IDs บน files/folders, role grants ต่อ API key (`admin`, `editor`, `viewer`), API สำหรับอ่าน/สร้างหน่วยงาน และ UI เลือกคลัง
- ทุก file/folder operation จำกัดด้วย department grants ที่ได้จาก API key ฝั่ง server; viewer อ่านได้, editor แก้ไขไฟล์ได้, admin เพิ่ม/ถ่ายทอดสิทธิ์ได้
- `departments:manage` เป็น application-wide administrator; `keys:manage` จัดการ key ได้เฉพาะคลังที่ key มี role `admin`; key อื่นต้องมี grant ระบุหน่วยงาน
- ตาราง `filesvc.files.department` เดิมและ object keys ไม่ถูกเปลี่ยน; ไฟล์เดิมถูกแมปจาก department label ไป department ID ใน migration
- รุ่นแรกของ migration ถูกปฏิเสธเพราะให้ key เดิมทุกตัวเป็น admin ทุกหน่วยงาน; รุ่นแก้ไขไม่ backfill grants, เก็บข้อมูลเดิมไว้, เพิ่ม rollback scripts และ apply สำเร็จแล้ว
- role ปัจจุบันผูกกับ API key ของ application; การยืนยันตัวตน SSO และสิทธิ์รายบุคคลยังเป็นงานถัดไป

## 11. Tech stack ปัจจุบัน

- **API:** Next.js App Router / TypeScript
- **Database:** Supabase PostgreSQL, schema `filesvc`, driver `pg`
- **Object storage:** Supabase Storage, private bucket `private-files`
- **Worker:** Node.js script สำหรับ outbox
- **Deployment target:** Railway (ยังไม่ได้ deploy/เชื่อม environment)
- **Client-side upload flow:** API ออก signed URL; client อัปโหลดตรงไป Storage
