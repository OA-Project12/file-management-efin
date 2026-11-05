# File Storage API

## ตรวจประเภทไฟล์จาก bytes — signature-v1

การตรวจชนิดเป็นขั้นก่อนเข้าคิว Malware scanning เมื่อผ่านการตรวจขนาดและชนิดแล้ว `complete` จึงตอบ `202 pending_scan`

Upload ใหม่และ version ใหม่รับเฉพาะ PDF (`.pdf`, `application/pdf`), JPEG (`.jpg`/`.jpeg`, `image/jpeg`) และ PNG (`.png`, `image/png`) นามสกุลและ MIME ไม่สนตัวพิมพ์ใหญ่เล็ก แต่ต้องตรงกับ signature และ Storage MIME ทั้งหมด ใช้ `originalName` ของฉบับ ไม่ใช้ display name; API clients ต้องส่ง MIME ที่ตรง ไม่รับ `application/octet-stream` ส่วน UI อนุมาน MIME จากนามสกุลเมื่อ browser ส่ง `File.type` ว่างเท่านั้น ทั้ง intent และ PUT ใช้ค่าเดียวกัน

Flow เดิม: สร้าง intent → PUT ตรง Storage → complete. Intent ปฏิเสธนามสกุล/MIME ที่ไม่รองรับก่อน grant/reservation; batch แยกผลรายไฟล์ Complete อ่าน prefix ไม่เกิน 1,024 bytes จาก private Storage ฝั่ง server (deadline 15 วินาที), ตรวจ metadata ก่อน/หลังและใช้ If-Match เมื่อมี ETag ก่อนเข้าคิวสแกน PDF ตรวจ `%PDF-`, JPEG ตรวจ `FF D8 FF`, PNG ตรวจ signature 8 bytes เท่านั้น **ไม่ใช่ parser ตรวจโครงสร้าง/ไฟล์เสีย และไม่ใช่ผลสแกนไวรัสหรือรับรองความปลอดภัย** ไฟล์ที่สร้าง signature ปลอม หรือ PDF ที่มี active content อาจผ่านชั้นนี้ได้; malware scanning และ preview hardening เป็นงานแยก

| Error code | HTTP | ความหมาย |
|---|---|---|
| `file_type_not_allowed` | 415 | นามสกุลหรือ MIME ไม่รองรับ |
| `file_signature_invalid` | 415 | ว่าง, signature สั้นหรือไม่รู้จัก |
| `file_type_mismatch` | 415 | เนื้อหาไม่ตรงกับนามสกุล/declared MIME/Storage MIME |
| `file_validation_unavailable` | 503 | Storage/stream/timeout ยังตรวจไม่ได้ คง pending และเรียก complete ใหม่ได้ภายในอายุ intent |
| `object_changed` | 409 | Metadata/ETag/version เปลี่ยนระหว่างตรวจ |

Upload ที่ตรวจไม่ผ่านเป็น `quarantined` พร้อม Audit และ quota settlement ใน transaction เดียว ไม่ publish และไม่แทน current version ไม่ลบ object ทันทีระหว่าง signed upload grant ยังใช้ได้ ใช้ cleanup เดิมหลังหมดอายุพร้อม grace period และคืนโควตาเมื่อ worker ยืนยันการลบเท่านั้น ความล้มเหลวของการอ่านไม่ถือว่าไฟล์ผิดประเภทและไม่ retry mutation อัตโนมัติ

ไฟล์เดิมยังค้นหา/preview/download ตามสิทธิ์และรูปแบบเดิม ไม่มี backfill หรือสแกนย้อนหลัง Complete ที่เสร็จแล้วเป็น idempotent การ restore จากถังขยะต้องตรวจฉบับปัจจุบันก่อน; restore เวอร์ชันตรวจทั้งต้นฉบับและสำเนาก่อน publish หากไม่ผ่านเก็บฉบับปัจจุบันเดิมไว้ ไม่เปลี่ยน bucket MIME allowlist, schema, endpoint หรือ scope และไม่มี deployment ในงานนี้

ผลตรวจในเครื่องเมื่อเพิ่มการตรวจชนิดไฟล์ผ่าน backend/security 35 กรณี, browser security/upload 5 กรณี, TypeScript, lint และ webpack production build รวมกรณี worker ต้องลองลบ object ใหม่ก่อนคืนพื้นที่ ตัวเลขนี้เป็นผลจากชุดทดสอบเดิม

### Security release preparation — 4 พฤศจิกายน 2569

The release preflight passed 18 security tests against disposable PostgreSQL/Redis, 4 browser security tests against a local production build using mocked services, TypeScript, lint and webpack production build. It covered the wrapped Next.js Request regression that previously returned 503 for JSON POST requests.

Deploy web first and worker second from the same clean release commit using Railway CLI and their existing service-specific configuration paths. Keep `RATE_LIMIT_MODE=report`; this counts/reports excess requests but does not block them. Verify Redis from inside the deployed web container with a PING, independently of report-mode readiness. Record release/deployment IDs and the previous deployment IDs in an operator report without credentials. Do not enable enforce until the team confirms normal flows, ingress IP handling and limits. No schema migration or quota apply is part of this release.

## Malware scanning และ Quarantine

1. สร้าง intent และ PUT ไปยัง private Supabase Storage เหมือนเดิม ส่ง `folderId` ใน intent เมื่อต้องการอัปโหลดเข้าที่ปลายทางโดยตรง
2. เรียก `POST /api/v1/files/{fileId}/complete` หรือ `POST /api/v1/files/{fileId}/versions/{versionId}/complete` เมื่อ PUT สำเร็จ การกู้คืนใช้ `POST /api/v1/files/{fileId}/restore` และ `POST /api/v1/files/{fileId}/versions/{versionId}/restore` ตามเดิม
3. HTTP `202` คืน `{ "data": { "fileId": "...", "scanId": "...", "status": "pending_scan", "statusUrl": "/api/v1/files/.../scan-jobs/..." } }` และมี `versionId` สำหรับงานระดับเวอร์ชัน เรียก GET ที่ `statusUrl` ด้วย identity ที่มี `files:write` และสิทธิ์ Editor ขึ้นไปในขอบเขตเดิม ผู้ใช้ API key ต้องแนบ `?ownerSubject=<เจ้าของไฟล์>` แบบ URL-encoded
4. อ่าน `data.status` ซึ่งเป็น `pending_scan`, `scanning`, `available`, `quarantined` หรือ `scan_failed` เมื่อพบสถานะสุดท้ายสามแบบให้หยุด polling การเรียก complete ซ้ำคืน scan ID เดิม โดยตอบ 200 เมื่องานจบแล้ว ไฟล์ที่เสร็จก่อน release นี้อาจคืน 200 พร้อม `available` โดยไม่มี scan ID

ไฟล์ใหม่ออก preview/download URL ได้หลัง `available` ฉบับปัจจุบันยังใช้ได้ระหว่างสแกนฉบับใหม่ ไฟล์เดิมอ่านได้ตามสิทธิ์เดิมและไม่มีการสแกนย้อนหลังอัตโนมัติ หากพบภัยระหว่าง restore ระบบปิดการออก URL ใหม่ของ object นั้น ส่วนลิงก์ที่ออกไปก่อนหน้าอาจใช้ได้ถึงเวลาหมดอายุหรือจน object ถูกลบ พื้นที่ยังถูกคิดจน worker ยืนยันว่า object ถูกลบหรือไม่มีอยู่แล้ว ดู [Supabase signed URL behavior](https://supabase.com/docs/guides/storage/serving/downloads#revoke-signed-urls)

ClamAV ตรวจได้ตามลายเซ็นและขีดจำกัดของ engine PDF เข้ารหัสหรือไฟล์ที่เกินขีดจำกัดถูกระบุว่าตรวจไม่ได้ การตรวจไม่ผ่านชั่วคราวลองสูงสุด 5 ครั้ง ภายใน 2 ชั่วโมง ไฟล์ใหม่ที่จบโดยเปิดใช้ไม่ได้เข้า cleanup หลัง upload grant หมดอายุและผ่าน grace 1 ชั่วโมง ต้นฉบับเดิมยังอยู่หาก scanner ขัดข้องหรือตรวจไม่ได้

### เปิดใช้บน Railway

1. นำ migration `db/migrations/20261105_malware_scan.sql` ไปใช้ผ่านผู้ดูแล schema หลังตรวจ migration เดิมของ versioning, folder access, quota และ cleanup ให้ครบ ตรวจว่า `filesvc_api` และ `filesvc_worker` เป็นคนละ role, schema `filesvc` ไม่เปิดผ่าน Data API และ Storage policies ไม่อนุญาตให้ `anon` หรือ `authenticated` อ่านไฟล์ตรงจาก bucket นี้
2. สร้าง service `efin-dms-clamav` จาก Dockerfile ใน `deploy/clamav` ใช้ RAM เริ่มต้น 4 GiB และ mount volume ที่ `/var/lib/clamav` เพื่อเก็บฐานลายเซ็น ให้ FreshClam อัปเดตได้และใช้ private networking พอร์ต 3310 โดยไม่สร้าง public domain หรือ TCP proxy Service นี้ใช้เฉพาะ ClamAV config และไม่มี DB หรือ Supabase credentials ดู [ClamAV Docker](https://docs.clamav.net/manual/Installing/Docker.html) และ [Railway private networking](https://docs.railway.com/networking/private-networking)
3. ใช้ web และ worker release เดียวกัน ตั้ง `MALWARE_SCAN_MODE=paused` ทั้งสอง service ก่อนตั้งค่า `CLAMD_HOST=efin-dms-clamav.railway.internal` และ `CLAMD_PORT=3310` ให้ worker ตรวจ `VERSION` และทดสอบ `INSTREAM` ด้วยข้อมูลจำลองในสภาพแวดล้อมทดสอบ ตรวจ bucket และ `MAX_UPLOAD_SIZE_BYTES` ให้สอดคล้องกับเพดาน ClamAV 25 MiB
4. หลัง worker เข้าถึง clamd และฐานลายเซ็นที่โหลดมีอายุไม่เกิน 72 ชั่วโมง ให้เปลี่ยน worker เป็น `required` ก่อนเปิด web เป็น `required` ตรวจผล clean/infected, สิทธิ์การอ่าน และการคืนพื้นที่โดยใช้ข้อมูลทดสอบ
5. ติดตาม `Malware scan queue` ซึ่งรายงานจำนวนงานและอายุงานเก่าสุดเป็นมิลลิวินาที รวมถึง `Malware scan retry scheduled`, `Malware scan failed`, `scanner_signatures_stale` และ `Malware cleanup deferred` ใน worker logs

เมื่อพักระบบให้เปลี่ยนเว็บเป็น `paused` ก่อน worker และรอ attempt ที่เริ่มไปแล้วจบ งานค้างยังอยู่ใน DB และ resume ตามอายุงานที่เหลือ เว็บจะตอบ `503 malware_scan_paused` สำหรับ upload/restore ใหม่ ไฟล์ที่อ่านได้อยู่ยังอ่านได้ตามสิทธิ์เดิม รักษา release ที่มี scan gate และ migration นี้ไว้ระหว่าง rollback สำหรับ quota maintenance ให้ใช้ขั้นตอนหยุด mutation และ drain ตามเดิม โดยรอ scan ที่กำลังทำงานด้วย

ทดสอบ ClamAV ด้วยไฟล์สะอาดและ EICAR ใน service ทดสอบที่แยกจากข้อมูลจริง สำหรับการทดสอบผ่านแอป ให้ตรวจว่าไฟล์ขึ้น `pending_scan` หลังอัปโหลดและขอ preview/download ได้เมื่อ worker บันทึกสถานะ `available` แล้ว

## Security hardening — รอบแรก

เพิ่ม guard กลางสำหรับ `/api/v1/*`, Redis token buckets, bounded JSON reader, timeouts, security headers และ structured logs โดยคงสิทธิ์และ API เดิม ไม่มี migration production

### Configuration และ Railway

- Redis เป็น service **private** ภายใน Railway project ไม่เปิด public domain/TCP proxy; ตั้งรหัสผ่าน และใช้ private URL ผ่าน service variable reference เฉพาะเว็บ Worker ไม่ต้องใช้ Redis
- `REDIS_URL`: runtime เท่านั้น ห้ามใส่ build ARG หรือ browser variables
- `RATE_LIMIT_KEY_SECRET`: secret สุ่มอิสระอย่างน้อย 32 bytes ใช้ HMAC ของ identity/IP ไม่ใช้ database password หรือ Supabase key แทน สร้างด้วย `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` ใน trusted terminal แล้วใส่ Railway Variables โดยไม่บันทึกลง Git/logs
- `RATE_LIMIT_MODE=report` เป็นค่าเริ่มต้น: นับ/รายงาน แต่ **ยังไม่ปฏิเสธ** คำขอที่เกิน rate หรือเมื่อ Redis ล่ม เมื่อทีมตรวจแล้วจึงเปลี่ยนเป็น `enforce` และ redeploy/restart
- `TRUSTED_PROXY_MODE=railway` เชื่อ `X-Real-IP` เฉพาะ ingress ของ Railway; ทีมต้องตรวจการ overwrite header กับ domain จริงก่อนเปิด enforce ไม่เชื่อ X-Forwarded-For หากไม่มี/ผิดรูปแบบใช้ bucket unknown ร่วม Local ใช้ `local` ซึ่งไม่เชื่อ forwarding headers
- `SECURITY_ENVIRONMENT`: namespace แยก environment; ถ้าไม่ตั้งใช้ Railway environment ID แล้วจึง NODE_ENV ทุก replica ของ environment เดียวกันต้องใช้ namespace และ HMAC secret เดียวกัน
- Private Redis ไม่มี endpoint สำหรับ browser; ไม่ใช้ Redis production จาก local tests ใช้ container แยกต่างหาก
- ค่า capacity ปรับได้ผ่าน `RATE_LIMIT_<IP|IDENTITY|GRANTS|UPLOADS|DESTRUCTIVE|INVITES|KEYS>_CAPACITY` ต้องเป็น integer 1–1,000,000 (uploads อย่างน้อย 20) รอบเวลาเติมกลับไม่เปลี่ยน

| Bucket | Capacity / refill period |
|---|---|
| IP ก่อน Auth | 600 / 60 วินาที |
| ผู้ใช้หรือ key ที่ยืนยันแล้ว | 300 / 60 วินาที |
| Preview/download URL ทุกเวอร์ชัน | 60 / 60 วินาที |
| Upload intents | 120 ไฟล์ / 60 วินาที; batch หักตามจำนวนไฟล์ |
| Version restore / purge | 10 / 60 วินาที |
| Invite | 10 / 3,600 วินาที |
| สร้าง/เพิกถอน key | 20 / 3,600 วินาที |

แต่ละ bucket เติม token ต่อเนื่องและมี burst สูงสุดเท่า capacity คำขอต้องผ่าน bucket ทั่วไปและเฉพาะงานพร้อมกัน Lua ใช้ Redis TIME และทำ admission แบบ atomic ไม่มีตัวนับ memory fallback ตัวนับมี TTL ไม่ใช่ข้อมูลธุรกิจถาวร Redis restart ที่สูญเสียข้อมูลอาจคืน burst budget จึงต้องติดตาม restart ด้วย

`429 rate_limited` มี `Retry-After`, `X-Request-Id`, `Cache-Control: no-store` และ `{ error: { code, message, requestId } }`; UI แสดงเวลารอ ไม่ replay mutation อัตโนมัติ ใน enforce เมื่อ Redis/config ใช้ไม่ได้คืน `503 security_control_unavailable` ก่อนเริ่ม mutation และ readiness/pre-deploy fail Health/static ไม่ผ่าน limiter; login ตรง Supabase Auth อยู่นอก limiter นี้

### Request limits และ timeout

- 4 KiB: search, keys, สร้าง folder/department, quota, URL grants และ status commands
- 16 KiB: upload intent เดี่ยว/version, metadata, user operations และ folder access
- 64 KiB: batch upload intent สูงสุด 20 ไฟล์
- นับ bytes จาก stream จริง (รวม UTF-8 ไทย), ไม่เชื่อ Content-Length อย่างเดียว รองรับ JSON ที่ไม่ระบุ Content-Type แต่ปฏิเสธชนิดอื่นที่ระบุชัดด้วย 415
- JSON ผิดรูปแบบคืน 400; เกินขนาด 413; อ่าน body เกิน 10 วินาทีคืน 408 ก่อนเริ่ม mutation ขนาดนี้ไม่ใช่เพดานเนื้อหาไฟล์ เพราะไฟล์ส่งตรง Storage
- API connection timeout 5s, SQL statement timeout 15s, lock timeout 5s; Supabase fetch 15s และ restore copy 60s ไม่เปลี่ยน worker/maintenance timeout โดยเหมารวม
- Timeout ไม่ได้แปลว่า Storage operation ไม่เคยเกิดขึ้น ระบบคง intent/reservation และ cleanup เดิม อย่าส่ง mutation ซ้ำโดยอัตโนมัติ

### Headers และ logs

CSP จำกัด resource origins ไปยังเว็บและ Supabase origin ที่กำหนด ไม่มี wildcard Supabase และไม่มี unsafe-eval ใน production คง inline script/style ที่ Next.js/controls ต้องใช้ จึงยังไม่ใช่ strict CSP แบบ nonce ไม่เปลี่ยน Cache Components/PPR

เพิ่ม frame-ancestors none, X-Frame-Options DENY, nosniff, no-referrer และ Permissions-Policy ปิด camera/microphone/geolocation HSTS production ใช้ max-age=31536000 ไม่รวม subdomains/preload เปลี่ยน NEXT_PUBLIC_SUPABASE_URL ต้อง rebuild ให้ browser bundle และ CSP ตรงกัน Headers ของ object ที่ Supabase ให้บริการโดยตรงไม่ได้ถูกเปลี่ยนจาก next.config

Logger กลางของ API/worker ใช้ allowlist ไม่ส่ง raw errors, body, headers หรือ SQL parameters ข้อมูล nested/ข้อความถูก redact และตัด credentials/query strings ของ URL Rate-limit warnings ถูกจำกัดความถี่ต่อ process ไม่เขียน Audit DB ทุกคำขอที่ถูก throttle Audit details ปฏิเสธ sensitive fields/credentials/signed URLs และ rollback ร่วมกับ mutation คำสั่ง key:create ยังคงพิมพ์ secret ครั้งเดียวตามหน้าที่เดิม

### การตรวจด้วยตนเอง

ก่อนเปิดเว็บจริง ให้ทีมตรวจ login/invitation, text/image/PDF preview, download, 429/Redis outage และ trusted client IP ในสภาพแวดล้อมทดสอบบน Railway

### CI และ rollout/rollback

Runtime image ใช้ Node.js 24 แบบ minimal, รันด้วย user node และไม่มี npm/npx/Yarn ใน final stage คำสั่ง cloud ต้องใช้ node โดยตรง ย้าย shadcn CLI ไป devDependencies เพราะ component code ไม่ import CLI ตอน runtime


`.github/workflows/security.yml` รัน TypeScript, lint, webpack production build, npm audit, Gitleaks full-history แบบ redact และ Trivy runtime image scan Actions และ scanner images pin SHA/digest และใช้ `contents: read`

High/Critical dependency/image vulnerabilities และ secret findings ทำให้ CI fail รวม scanner/network error ด้วย ไม่เพิ่ม ignore กว้างหรือใช้ audit fix --force ข้อยกเว้นต้องระบุ advisory เหตุผล ผู้รับผิดชอบ และ expiry ผ่านการ review แยกต่างหาก Low/Moderate ยังต้องติดตามแม้ไม่เป็น blocking threshold รอบนี้

ตั้ง branch protection/ruleset ของ master ให้ require: Security and regression, Dependency scan, Secret scan, Runtime image scan โดยผู้ดูแล repository หลัง workflow ถูก push และตรวจผ่าน การเพิ่ม workflow อย่างเดียวไม่ได้บังคับ merge ผ่าน CI

Rollout: เตรียม private Redis/variables → deploy release ใน report → ทีมตรวจ flow/headers/IP และดู warnings → ปรับ capacity ตามหลักฐาน → เปิด enforce และตรวจ readiness หากจำเป็นต้องคืน availability ระหว่าง Redis outage เปลี่ยนกลับ report และ restart เว็บ โดยเข้าใจว่า rate limiting จะไม่ block ชั่วคราว ไม่ลบ Audit/ไฟล์/โควตาเพื่อ rollback งานนี้ไม่มี schema migration และไม่มีการ deploy หรือแก้ branch protection อัตโนมัติ


## Railway: ทดสอบบนคลาวด์ใน project EFIN DMS

ใช้ Supabase เดิมทั้ง Database/Auth/Storage จึงเป็นข้อมูลชุดเดียวกับ local งานนี้ไม่เพิ่ม schema และไม่ย้ายไฟล์เข้า Railway

### ไฟล์และ configuration

| Service | ไฟล์อ้างอิงค่า Settings | หน้าที่ |
|---|---|---|
| `efin-dms-web` | `/railway.web.json` | Next.js UI/API, HTTPS, healthcheck `/api/health/ready` |
| `efin-dms-worker` | `/railway.worker.json` | Outbox/cleanup/audit retention; ไม่มี public domain |

**ข้อจำกัดที่ยืนยันจาก Dashboard และเอกสาร Railway วันที่ 3 พฤศจิกายน 2569:** service ใหม่ไม่สามารถเปิดใช้ Config as Code เดิมได้แล้ว ไฟล์ `railway.web.json`/`railway.worker.json` ใน repository ใช้เป็นรายการอ้างอิงเท่านั้น **อย่าตั้ง Railway Config File path ให้ service ใหม่** ให้ตั้งค่าผ่าน Dashboard ตามตารางด้านล่าง รอบนี้ยังไม่ได้ติดตั้ง Railway IaC SDK หรือเปลี่ยน authentication สำหรับ CLI บริการ legacy ที่เปิด Config as Code ไว้แล้วใช้ได้ถึง 1 ธันวาคม 2569 เท่านั้น ดู [Railway Config as Code](https://docs.railway.com/config-as-code) และ [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)

| Settings | เว็บ | Worker |
|---|---|---|
| Dockerfile path | `/Dockerfile` (ตรวจ build logs ว่าใช้ Dockerfile) | เหมือนเว็บ |
| Root directory | Repository root | Repository root |
| Start command | `node node_modules/next/dist/bin/next start --hostname 0.0.0.0` | `node scripts/process-outbox.mjs` |
| Pre-deploy (อ่านอย่างเดียว) | `node scripts/check-deployment.mjs web` | `node scripts/check-deployment.mjs worker` |
| Region / replicas | Singapore / 1 | Singapore / 1 |
| Serverless | ปิด | ปิด |
| Restart policy / retries | On Failure / 10 | On Failure / 10 |
| Healthcheck / timeout | `/api/health/ready` / 300 วินาที | ไม่ตั้ง HTTP healthcheck |
| Teardown overlap / draining | 0 / 60 วินาที | 0 / 120 วินาที |
| Public domain | Railway HTTPS domain | ไม่สร้าง |
| GitHub branch / autodeploy | `codex/railway-cloud-test` / ปิด | เหมือนเว็บ |

ทั้งสองใช้ Dockerfile เดียว ไม่ต้องมี Railway database หรือ Volume ตรวจรายการ staged changes ก่อนกด Deploy และตรวจค่าจาก Settings อีกครั้งหลังบันทึก โดยต้องมี Dockerfile path ที่ถูกต้องและ build logs ยืนยัน Dockerfile detection

สำหรับ Railway CLI/Public API รุ่นที่ใช้ตรวจ (CLI 5.71.0) enum `Builder` มี `RAILPACK` แต่ไม่มี `DOCKERFILE` จึงคง builder ที่ API รองรับและตั้ง `dockerfilePath=/Dockerfile` ให้ระบบตรวจพบไฟล์ โดยยึด build logs เป็นหลักฐานว่าใช้ Dockerfile จริง ไม่ส่งค่า `DOCKERFILE` เข้า GraphQL enum โดยตรง

Start Command ของ Docker deployment ถูกเรียกแบบ exec form จึงใช้ `node ...` โดยตรง ไม่ใส่ `exec` นำหน้าเหมือน shell script (`exec` ไม่ใช่ executable ใน image) และไม่ต้องขยาย `$PORT` ใน command เพราะ Next.js อ่าน environment เอง ดู [Railway Start Command](https://docs.railway.com/deployments/start-command)

ใช้ read-only preflight เป็น pre-deploy command เพื่อตรวจ TLS/role/application/private bucket จาก runtime บน Railway โดยตรงก่อนเริ่ม process จริง ไม่ต้องสร้าง SSH key สำหรับการตรวจนี้ และไม่เรียก cleanup/retention หรือเขียนฐานข้อมูล หากตรวจไม่ผ่าน deployment ต้องหยุด ส่วน healthcheck ยังใช้ตรวจ database readiness เมื่อเว็บเริ่มแล้ว

### ทางเลือกส่ง release ด้วย CLI (เลือกใช้กับ EFIN DMS รอบนี้)

Railway บัญชี `efinbackend` เชื่อม GitHub เป็น `efinbackend` ส่วน repository เป็นของ `OA-Project12` และ Railway App ฝั่ง OA-Project12 มีสิทธิ์ repository แล้ว ผู้ใช้เลือกส่ง source ด้วย CLI เพื่อคง GitHub integration เดิม การ deploy รอบนี้จึงไม่ผูก GitHub source/autodeploy

- ใช้ Railway CLI ทางการ `@railway/cli` ซึ่งติดตั้งใน `.quota-reports/railway-cli` และเข้าสู่บัญชีเดิม ไม่แก้ dependencies ของแอป
- Project ID: `0f2d2814-12e7-4bd6-a6f6-1459a87a93f4`; environment ID: `6f2d7ed8-cab0-4ebc-a6b8-3078d62a3fbf` (ชื่อ Railway คือ `production` แต่ยังใช้เพื่อ cloud test)
- Web service ID: `95cbfca8-1361-4a06-8b06-4f973445885f`; worker service ID: `d98fba63-16c5-478d-9dd6-20983dc210e4`
- สร้าง source directory จาก `git archive` ของ release commit เท่านั้น ตรวจไม่มี `.env*`, secrets หรือรายงาน แล้วส่งด้วย `railway up <release-directory> --path-as-root --project <PROJECT_ID> --environment <ENVIRONMENT_ID> --service <SERVICE_ID> --detach --message <RELEASE_SHA>` แยกทั้งสอง service
- `up --detach` หมายถึงเริ่ม deploy แล้ว ไม่ใช่ตรวจว่าพร้อมใช้งาน ต้องตาม deployment status/build logs/healthcheck ต่อจนสำเร็จ
- เว็บกำหนด `PORT=3000` ให้ตรง target port ของ Railway domain และใช้ `AUTH_INVITE_REDIRECT_URL=https://efin-dms-web-production.up.railway.app/set-password` ต้องเพิ่ม exact Redirect URL ใน Supabase ก่อนทดสอบคำเชิญ
- เริ่มเว็บด้วย maintenance เปิดไว้เพื่ออ่าน/ตรวจ health ก่อน ส่วน worker จะเริ่มหลังหยุด local worker และตรวจงานค้างแล้วเท่านั้น การสร้าง empty worker/ตั้ง Variables ไม่ได้เริ่มประมวลผลงาน

Docker ใช้ Node 24, `npm ci`, webpack production build และ production dependencies รันด้วยผู้ใช้ `node` คำสั่งเว็บใช้ `PORT` ที่ Railway ส่งมาและ bind `0.0.0.0` worker ใช้ `node scripts/process-outbox.mjs` จึงไม่ต้องมี `.env.local` คำสั่ง npm สำหรับ local ยังทำงานเหมือนเดิม

ใส่ Railway Variables ตาม `railway.variables.example` ซึ่งมีเฉพาะ placeholder:

- ทั้งสอง service: Supabase URL/secret, private bucket และค่า maintenance ตามตัวอย่าง ตั้ง database URL เฉพาะที่ service นั้นต้องใช้
- **ทั้งสอง build** ต้องมี `NEXT_PUBLIC_SUPABASE_URL` และ `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` เพราะ build image เดียวกัน แม้ worker ไม่ใช้ browser configuration ขณะรัน เปลี่ยนสองค่านี้ต้อง rebuild
- เว็บ: `DATABASE_URL`, `AUTH_APPLICATION_ID`, `AUTH_INVITE_REDIRECT_URL`, `MAX_UPLOAD_SIZE_BYTES` worker: `WORKER_DATABASE_URL` และ alert webhook เดิมถ้ามี
- Runtime secrets ไม่ถูกประกาศเป็น Docker ARG และไม่ต้องใช้ระหว่าง build; ห้ามส่ง `.env.local` ไป build context หรือ commit secrets
- ใช้ Session Pooler พอร์ต 5432 กับ login สำหรับ `filesvc_api` และ `filesvc_worker` แยกกัน ไม่ใช้ `postgres` และ URL-encode password ส่วน pools ปัจจุบันใช้ได้สูงสุดเว็บ 5 + worker 2 connections ต่อชุด deployment ต้องเผื่อ local และ deployment ที่ซ้อนระหว่างเปลี่ยนรุ่นด้วย
- ใช้ `sslmode=verify-full` และ CA ที่ตรวจแล้ว Linux path คือ `/app/certs/prod-ca-2021.crt`; image ตั้ง `NODE_EXTRA_CA_CERTS` ไว้ ห้ามใช้ Windows path, `NODE_TLS_REJECT_UNAUTHORIZED=0` หรือปิด `rejectUnauthorized` CA เป็น public certificate ไม่ใช่ private key แต่ต้องตรวจวันหมดอายุ/การหมุนเวียนก่อนปล่อยแต่ละครั้ง

### Build และ preflight

รันจาก PowerShell โดยใส่ **เฉพาะ public values** ใน process environment (อย่าใส่ server secret เป็น build arg):

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL = 'https://<project-ref>.supabase.co'
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = '<publishable-key>'
docker build --build-arg NEXT_PUBLIC_SUPABASE_URL --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY -t efin-dms:railway-test .
```

สร้างไฟล์ variables แยก web/worker ไว้ในตำแหน่งที่ Git ignore โดยใช้ค่าจริงเฉพาะ runtime และ Linux certificate path Docker `--env-file` ใช้ `NAME=value` ไม่มี shell quoting หรือ variable expansion จากนั้นตรวจแบบอ่านอย่างเดียว:

```powershell
docker run --rm --env-file .quota-reports/railway-web.env efin-dms:railway-test node scripts/check-deployment.mjs web
docker run --rm --env-file .quota-reports/railway-worker.env efin-dms:railway-test node scripts/check-deployment.mjs worker
docker run --rm --name efin-dms-web-test -p 127.0.0.1:3018:3000 --env-file .quota-reports/railway-web.env efin-dms:railway-test
# อีก terminal: Invoke-RestMethod http://127.0.0.1:3018/api/health/ready
# หลังตรวจเสร็จ: docker stop efin-dms-web-test
```

`check-deployment.mjs` ตรวจ TLS, dedicated login/role, active application (web), outbox read/audit function privilege (worker) และ private bucket โดยไม่เริ่ม worker หรือแก้ข้อมูล ผล roundTripMs เป็นเวลาจากตำแหน่งที่รันสคริปต์ ไม่ใช่ latency จาก Railway ถ้าบucket ยังไม่มี size limit ต้องตรวจให้ตรงข้อจำกัด upload ก่อนเปิดให้ทีมทดสอบ

### ลำดับ deploy

1. ยืนยัน backup/จุดกู้คืนของ Supabase ที่มีอยู่ก่อน หากยังยืนยันไม่ได้ให้คงการทดสอบ cloud แบบอ่านอย่างเดียว บันทึก release commit และค่าตั้งต้นของ services โดยไม่บันทึก secret ลง Git
2. รวมโค้ด UI และ deployment files ที่ตรวจแล้วเข้า release commit เดียวบน GitHub เก็บการแก้เดิมทั้งหมด ไม่ต้องนำ `.env.local`, reports, `docs`, `supabase`, `postman`, `prototype` หรือ `.agents` ขึ้น Git
3. ใน project **EFIN DMS** สร้าง web จาก `OA-Project12/file-management-efin` ตั้ง Service Settings ตามตารางและ Variables แล้วปิด automatic deployments ถ้าค้นหา repository ไม่พบต้องให้ Railway GitHub App เข้าถึงเฉพาะ repository นี้ก่อน อย่าใช้ repository ชื่อใกล้เคียงแทน Deploy commit ที่เลือกด้วยตนเอง แล้วสร้าง Railway HTTPS domain ตรวจ healthcheck/login/รายการไฟล์ก่อน
4. ตั้ง `AUTH_INVITE_REDIRECT_URL=https://<railway-domain>/set-password` เพิ่ม exact URL ใน Supabase Auth Redirect URLs และตรวจ email template ว่าใช้ redirect ที่ส่งมา เก็บ localhost และ Site URL/กติกาสมัครสมาชิกเดิมไว้ในรอบ cloud test
5. ทดสอบเชิญ/ตั้งรหัสผ่านด้วยบัญชีทดสอบ Default SMTP ของ Supabase ส่งได้เฉพาะอีเมลที่ระบบอนุญาต ถ้าจะเชิญบุคคลทั่วไปต้องตั้ง custom SMTP ก่อน ไม่เปลี่ยน SMTP หรือสร้างบัญชีใหม่โดยไม่ระบุผู้ให้บริการ/ผู้รับ
6. หยุด local worker ที่ใช้ Supabase เดียวกันก่อนเปิด cloud worker ตรวจงานค้าง/cleanup ที่ถึงกำหนด เพราะ worker จะทำงานกับข้อมูลเดิมทั้ง application ไม่ได้จำกัดเฉพาะไฟล์ทดสอบ สร้าง worker service/Settings/Variables ตามตารางโดยไม่เพิ่ม public domain แล้ว deploy release commit เดียวกับเว็บ
7. รัน read-only preflight จาก runtime บน Railway อีกครั้งเพื่อบันทึก latency/สิทธิ์จริง เปิด logs ตรวจ outbox retry, cleanup และ audit retention ไม่เรียก retention function เองเพื่อทดสอบ
8. ทดสอบ upload/complete, preview/download, metadata, versions/restore, trash/restore/purge, Audit และ quota ด้วยไฟล์ทดสอบที่ระบุไว้ ตรวจ restart/redeploy แล้วข้อมูลยังอยู่บน Supabase

ไม่รัน migration, bootstrap admin, create key, storage limits, quota backfill หรือ `--apply` ใน build/start/pre-deploy อัตโนมัติ ไม่ตั้ง finite quota ให้หน่วยงานจริงเพื่อทดสอบ

### Maintenance, monitoring และ rollback

`STORAGE_QUOTA_CONTROL_DIR=/tmp/efin-dms-quota` เป็นพื้นที่ชั่วคราวในแต่ละ container **ไม่แชร์** ระหว่างเว็บกับ worker และหายเมื่อสร้าง container ใหม่ ไม่ต้องเพิ่ม Railway Volume เพื่อเก็บไฟล์ผู้ใช้ เพราะอยู่บน Supabase อยู่แล้ว

หากต้องใช้ quota `--apply` ให้หยุด direct writers และตั้ง `STORAGE_QUOTA_MAINTENANCE=1` แล้ว restart **ทุก** web/worker/local instance ที่ใช้ฐานข้อมูลเดียวกัน รอคำขอเดิมจบและยืนยันว่า worker ไม่ทำ cleanup/purge ค่อย apply จากผู้ปฏิบัติงานคนเดียว lock file ของ CLI ไม่ได้หยุด services บน host อื่น Signed upload URL เดิมยังส่งเข้า Storage ได้ จึงต้องคง reservation/ตรวจ snapshot ตามเครื่องมือเดิม เมื่อ reconcile ผ่านค่อยคืน flag เป็น `0` และ restart ทุก instance

ตรวจ web health/logs, worker restarts, งาน outbox ที่ค้าง/ล้มเหลว และ audit retention ผ่านช่องทางปฏิบัติการเดิม Railway healthcheck ตรวจตอน deploy เท่านั้น ตั้ง external uptime monitor ที่ URL `/api/health/ready` ก่อนเปิดจริง โดยไม่ใส่ token ลง URL และไม่ส่ง secret/signed URL เข้า logs บันทึกผล smoke test ว่าผ่าน/ไม่ผ่าน/ยังไม่ได้ตรวจแยกกัน

เมื่อจำเป็นต้อง rollback ให้ pause mutation/worker ตามผลกระทบ แล้ว deploy release ก่อนหน้าที่เข้ากันได้ทั้งเว็บและ worker ตรวจ public build variables, healthcheck และ outbox ก่อนคืนระบบ **rollback image ไม่กู้ไฟล์ที่ purge แล้วและไม่ย้อนข้อมูลที่แก้** รอบนี้ไม่มี schema migration จึงไม่มี migration rollback

เอกสารอ้างอิง: [Railway Dockerfiles](https://docs.railway.com/builds/dockerfiles), [configuration](https://docs.railway.com/config-as-code/reference), [healthchecks](https://docs.railway.com/deployments/healthchecks), [Supabase connections](https://supabase.com/docs/guides/database/connecting-to-postgres), [Auth redirects](https://supabase.com/docs/guides/auth/redirect-urls), [SMTP](https://supabase.com/docs/guides/auth/auth-smtp)

### ผลตรวจเตรียม deploy — 3 พฤศจิกายน 2569

- ผ่าน: Docker Linux production build โดยไม่มี server secrets ตอน build, รันด้วย UID 1000, ไม่มี `.env.local` ใน image, maintenance directory เขียนได้ และ `PORT=8080`/bind `0.0.0.0` ทำงาน
- ผ่าน: `/api/health/live` และ `/api/health/ready` จาก container; preflight เว็บ/worker ไปยัง Supabase เดิมผ่าน TLS ที่ตรวจ certificate แล้ว รวม role, active application, private bucket, outbox read และสิทธิ์เรียก audit retention (ไม่ได้เรียก function จริง)
- ผ่าน: UI suites CURRENT/Search/Version/Quota บน Linux image ด้วย API/Auth/Storage จำลอง และตรวจ browser output 71 ไฟล์ไม่พบ runtime database URLs หรือ Supabase secret
- ผ่าน: quota reconciliation แบบรายงานจาก Linux image ตรวจครบ 3 หน่วยงาน issues=0 โดยไม่มี `--apply` และไม่เปลี่ยนยอด รายงานอยู่ในโฟลเดอร์ Git ignore
- Worker ตรวจการโหลด modules และปฏิเสธเริ่มงานเมื่อไม่มี configuration แล้ว ยังไม่ได้เริ่ม worker จริงเพื่อไม่ประมวลผลงานลบเดิมก่อนตรวจขั้นตอนเปิดระบบ
- ยังไม่ได้ตรวจบน Railway: สร้าง project/services/domain, latency จาก Singapore, invitation ผ่าน Railway URL, live-role smoke tests, cloud worker และ restart/redeploy ขณะใช้ข้อมูลจริง ต้องมีบัญชี Railway ที่เชื่อมต่อก่อน ผล local/container ไม่ถือเป็นผล smoke test บน Railway

## CURRENT design implementation

The application implements the CURRENT screens and interactions from `design/MASTER.md` and `design/EFIN_DMS_UX_UI_SPEC.md`. The light Neutral + Teal theme, IBM Plex Sans Thai, controls, focus indicators and responsive layouts share semantic tokens. Active styles are `globals.css`, `dms.css` and the scoped version/quota styles; the legacy redesign and search styles are no longer imported.

- File workspace, trash scope and storage filters are independent. Returning to files preserves the last workspace; **ไฟล์ทุกหน่วยงาน** explicitly clears its department/folder. Expanded navigation branches read immediate children through the existing folder API.
- Desktop details use a 440px dock from 1312px; smaller widths use a modal sheet. Tablet navigation is a drawer; mobile has **ไฟล์ / ถังขยะ / เพิ่มเติม**, cards and full-screen forms. Unsaved changes require an explicit discard; active mutations/uploads block context changes.
- Search retains applied/draft criteria, removable filter chips and cursor pagination. Preview/download only request URLs on user action; plain text renders as text. Dates display Thai Buddhist years in Asia/Bangkok, and audit wall-time filters explicitly convert UTC+7 independently of the browser timezone.
- Upload queues distinguish sending, confirming, partial folder-move failure and unknown outcomes. Only pre-send retryable entries may start another upload. Version operation state belongs to the details owner so switching dock/sheet presentation does not abort a version upload.
- Trash uses a queued receipt after purge; it does not claim physical deletion or released quota. Quotas retain exact-byte conversion, revision checks and separate used/reserved presentation.
- Auth users, including Tenant Admins, still do not receive `keys:manage`. The conditional key UI preserves one-time secret acknowledgement and can only be exercised with an authorized identity; no production entry point was added for ordinary Auth sessions.

There are no new backend endpoints, database migrations, scopes, sharing features, folder CRUD, bulk operations or deep links in this change. Existing API authorization remains authoritative. Drafts and one-time content grants stay in memory; the existing Supabase Auth session persistence is unchanged.

Use T01–T23 in the design specification as the manual acceptance checklist. Reports under `.quota-reports/` contain historical test results.

## File name and metadata keyword search

`POST /api/v1/files/search` accepts optional `q` together with all existing filters:

```json
{
  "q": "งบ 2569",
  "departmentId": "<DEPARTMENT_UUID>",
  "limit": 25
}
```

Auth users omit `ownerSubject`; API keys still must supply it. Identity, application, department membership and every restricted folder ancestor are checked exactly as before. Search only returns available files outside trash; it reads current `display_name`, current-version `original_name` cached on the document and `tags`. A document's display name/tags may intentionally remain unchanged when publishing a new version. Old version names, file contents, folder/department names and OCR text are not searched.

All whitespace-separated terms must match, but can match different fields and different tags: `งบ 2569` matches a file named `งบการเงิน.pdf` tagged `2569`. Matching is case-insensitive and allows literal substrings in Thai/English. Whitespace is trimmed/collapsed; there is no automatic Thai word segmentation, stemming, fuzzy matching, Boolean syntax or phrase-quote syntax. `%`, `_`, backslash and quotes are treated as literal text, not caller-controlled SQL/wildcards. Existing `tag` remains an exact, case-sensitive filter in addition to keyword matching.

An omitted/null/blank `q` preserves the old listing behavior. Other types, normalized values over 200 UTF-16 code units or more than 10 whitespace-separated terms return `400 invalid_search_query`. The existing 4096-byte request-body limit still applies. SQL uses parameters and literal `ILIKE` patterns; no keyword is inserted into SQL text or audit details.

The response stays `{ "data": { "items": [...], "nextCursor": "..." } }` with `Cache-Control: no-store`, ordered by creation time descending then ID descending. Default page size is 25, maximum 100. Pass `nextCursor` back unchanged with the same applied keyword, filters and identity. Keyword cursors contain a SHA-256 fingerprint of the normalized criteria and authenticated scope (including user/API key ID); changing criteria/identity or supplying an old keyword-free cursor with a keyword returns `400 invalid_cursor`. Keyword-free clients retain legacy cursors. The fingerprint is a consistency check, not authorization or a signed token: every page still rechecks access. Results are not a transaction-wide snapshot; concurrent renames/moves/uploads can change membership, so start a new search to refresh.

The file workspace has **ค้นหาชื่อไฟล์หรือ tags**, an explicit **ค้นหา** button/Enter and an indicator of the applied keyword. Typing alone makes no request. Search and **ใช้ตัวกรอง** apply the same draft keyword/filter values; **โหลดไฟล์เพิ่ม** and retry use applied criteria rather than unsent edits. **ล้างคำค้น** preserves applied metadata filters; **ล้างทั้งหมด** clears keyword/extra filters while retaining the current department/folder. Searching within a folder does not recurse into its children. Keyword results contain files only; the sidebar still allows folder navigation. New searches reset pagination, and stale responses cannot replace newer query/scope results. Loaded counts are not presented as total result counts.

Search reads metadata directly, so metadata changes and successful version publication/restore are searchable immediately. This release adds no schema, extension, index, search service, extraction worker or backfill. It uses existing scoped listing indexes. A rollback-only fixture with 5,000 additional files measured approximately 209 ms for PostgreSQL execution on the initial test run (not end-to-end API latency or a performance guarantee); inspect the recorded EXPLAIN baseline before planning larger-scale indexing.


The database check uses isolated TEMP tables and a TEMP copy of the existing folder-visibility function, rolls everything back, and prints EXPLAIN timings. It covers literal matching/injection, criteria-bound cursors, legacy clients, tenant/application/owner/folder isolation and current metadata. The UI check uses mocked Auth/APIs and Playwright with installed Chrome at 1440px/390px. It expects a running test server on `http://localhost:3017` (override `SEARCH_UI_URL`), and uses `PLAYWRIGHT_MODULE` / `SEARCH_UI_BROWSER` overrides or the same ignored test runtime as quota UI tests. Screenshots are saved to `.quota-reports/search-ui/`. Tests do not change real files or permissions.

## Department quota rollout — backfill and reconciliation

New uploads (including batch), version uploads and version restores now reserve bytes and settle actual stored bytes in the same database transaction as their file/version changes and audit records. Completed retries do not charge twice. Requests denied for capacity return `409 department_quota_exceeded`; batch requests preserve the existing partial-success format with a per-file error code.

The caller must supply the correct file size. Actual bytes above the reservation are charged as observed but quarantined with `409 upload_size_exceeds_reservation`; the previous current version remains selected. Per-file size violations still return `413 file_too_large`. Failed restore reservations and rejected objects stay `release_pending` until the cleanup worker confirms object deletion or absence; a failed/expired operation does not automatically return quota.

Cleanup and permanent-purge workers now release used/reserved bytes only after Storage removal succeeds. Allocation release, counters, job completion and audit records commit together. Retries cannot release the same allocation twice. Moving a file to trash and restoring it do not release or reserve space. Permanent purge verifies removal of every version and outstanding allocation before releasing the file's accounting; it waits for outstanding upload/restore grants to expire first.

Changing a file's department through the metadata endpoint transfers all outstanding allocations, including historical versions and pending upload/restore reservations. The destination must have capacity for both used and reserved bytes; otherwise the entire move returns `409 department_quota_exceeded` without changing the file. Transfers and worker releases lock the parent file and quota rows consistently, including a move while Storage removal is in progress. Object keys stay unchanged, and previously released allocation history retains its original department. If an initialized quota is involved but historical objects lack allocations, the move fails with `503 quota_accounting_not_ready` until backfill covers them.

The initial backfill on 2026-11-02 verified all three existing departments against Storage and initialized their accounting. Limits remain unlimited (`limit_bytes=NULL`) until a Tenant Admin changes them. Newly created or unverified departments still return `pending_backfill` with unknown totals. A finite limit on uninitialized accounting fails closed with `503 quota_accounting_not_ready`. The **พื้นที่จัดเก็บ** screen and quota endpoints below provide scoped usage and limit management. Restart the API and outbox worker after installing these changes; this step needs no additional migration.

This step does not enforce a physical hard cap on direct signed uploads; publication is validated at complete, and bucket limits plus cleanup still apply.

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

Next.js App Router API foundation for the shared File Storage Service. The project uses TypeScript, Route Handlers, PostgreSQL via `pg`, and Supabase Storage via `@supabase/supabase-js`.

Invited-user Supabase Auth setup and Tenant Admin bootstrap: [docs/SUPABASE_AUTH_SETUP.md](docs/SUPABASE_AUTH_SETUP.md).

Tenant Admin audit history is available at `GET /api/v1/audit-events` and in the **ประวัติการใช้งาน** screen. Keep `npm.cmd run worker:outbox` running so audit retention executes daily. Set `AUDIT_ALERT_WEBHOOK_URL` to an HTTPS endpoint that accepts JSON to receive retention failure alerts; also monitor the worker log for `Audit retention failed`.

The same worker cleans up tracked incomplete uploads and restore copies every minute (up to 10 objects per cycle), after their intent expires plus a one-hour grace period. It preserves current/available versions and recoverable trash, records durable jobs in `filesvc.object_cleanup_jobs`, and retries failures. Apply migrations and restart the worker when updating; see [cleanup behavior](docs/API_DOCUMENTATION.md#cleanup-ของ-uploadrestore-ที่ค้าง). Logs beginning with `Abandoned object cleanup failed` require monitoring; this job does not send alerts via the audit-retention webhook.


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

- Web and worker are deployed independently; keep runtime credentials in platform variables and follow the Railway setup above.
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
- `POST /api/v1/files/{fileId}/complete` verifies that the object exists, checks actual size and signature, and queues malware scanning with `202 pending_scan`. Oversized uploads are quarantined and cleaned up after the upload grant expires and its grace period ends.
- `POST /api/v1/files/{fileId}/download-url` requires `files:read` and an `ownerSubject`; it returns a five-minute signed URL only when the file belongs to the key's tenant/application and that owner.
- `POST /api/v1/files/search` requires `files:read` and an `ownerSubject`; it returns available file metadata with cursor pagination, without exposing Storage object paths.
- `POST /api/v1/files/{fileId}/delete` requires `files:write` and Editor/Admin role; it moves an available file to trash while retaining the Storage object. It returns `200` with `trashed: true`.
- `GET /api/v1/files/trash` lists trashed files with cursor pagination. `POST /api/v1/files/{fileId}/restore` queues an Editor/Admin-accessible file for a scan. It stays in trash until the scan passes.
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

### Security rollout preparation — 4 พฤศจิกายน 2569

สร้าง Railway service `efin-dms-redis` (ID `dacabc32-d867-4347-97d9-af1d1eb97395`) ใน project EFIN DMS, Singapore 1 replica, sleep ปิด ตรวจไม่มี public domain และไม่มี TCP proxy แล้ว ตั้ง Redis reference, HMAC secret และ report mode เป็น staged web variables ด้วย skip-deploys ไม่แสดงค่าลับ ไม่ deploy เว็บ/worker รุ่นใหม่นี้ และยังไม่เปิด enforce ผลทดสอบบน Railway ให้ทีมตรวจหลัง deploy release นี้

ผลตรวจ local ของ security release (4 พฤศจิกายน 2569): backend/security tests 17 กรณีผ่าน พร้อม Search/Version/Quota regression; CURRENT UI 13 กลุ่มและ responsive 375/390/768/1024/1280/1440 ผ่าน; browser security tests 3 กรณีผ่าน รวม login/invitation error, response headers และ text/image/PDF preview/download ด้วย mocks Gitleaks ตรวจ history 22 commits และ source working tree ไม่พบ leaks ตามกฎที่ใช้ npm audit ไม่มี High/Critical (ยังมี Low/Moderate ใน dev dependencies) Runtime เปลี่ยนเป็น Node24 Alpine หลัง Debian มี unpatched OS findings; Alpine scan ไม่พบ High/Critical โดยไม่เพิ่ม ignore ไม่มีการยืนยันผล CI บน GitHub หรือ flow จริงบน Railway ในรอบนี้

### Test-script removal

The legacy regression scripts under `scripts/` and the later security, file-validation, scanner and browser test suites under `tests/` were removed with their npm and CI commands. Use the manual acceptance steps above for those flows.
