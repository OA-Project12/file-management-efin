# การเข้าสู่ระบบด้วย Supabase Auth และสิทธิ์ตามหน่วยงาน

ผู้ใช้เข้าสู่ระบบบนเว็บด้วยอีเมลและรหัสผ่านผ่าน Supabase Auth จากนั้น File API ตรวจสอบ access token บนเซิร์ฟเวอร์ ส่วน API key ที่ขึ้นต้นด้วย `fsvc_` ยังใช้กับการเชื่อมต่อระหว่างเซิร์ฟเวอร์ที่เชื่อถือได้ เว็บเบราว์เซอร์จะไม่ได้รับ application API key หรือ Supabase secret key

## การตั้งค่าใน Dashboard

1. ไปที่ **Authentication → Sign In / Providers → Email** แล้วเปิดการเข้าสู่ระบบด้วยอีเมลและรหัสผ่าน รวมถึง **Confirm Email**
2. ปัจจุบันโปรเจกต์เปิด **Allow new users to sign up** อยู่ ผู้ที่สมัครบัญชี Auth เองจะไม่มีข้อมูลสมาชิกใน `filesvc.tenant_users` จึงเข้าใช้ File API ไม่ได้ การเชิญโดย Tenant Admin เป็นวิธีกำหนดสิทธิ์เข้าใช้ File API
3. ปัจจุบัน Site URL คือ `http://localhost:3000` และยังไม่มี Redirect URLs เพิ่มเติม ลิงก์เชิญจะกลับมายัง Site URL จากนั้นแอปตรวจ token ในลิงก์และเปิดหน้า `/set-password`
4. ก่อนใช้งานจริง ให้ตั้งค่าผู้ให้บริการ SMTP และเทมเพลตอีเมล **Invite user** การปิดการสมัครเองและเพิ่ม Redirect URLs เฉพาะเป็นการตั้งค่าความปลอดภัยเพิ่มเติม ซึ่งต้องตัดสินใจปรับใน Dashboard แยกต่างหาก

## ตัวแปรสภาพแวดล้อม

`SUPABASE_URL`, `SUPABASE_SECRET_KEY` และ `DATABASE_URL` ใช้เฉพาะฝั่งเซิร์ฟเวอร์ เพิ่มตัวแปรต่อไปนี้ใน `.env.local` และ Railway:

```text
NEXT_PUBLIC_SUPABASE_URL=<URL ของโปรเจกต์ Supabase>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
AUTH_APPLICATION_ID=<filesvc.applications.id ของเว็บแอปนี้>
AUTH_INVITE_REDIRECT_URL=
```

ค่า `NEXT_PUBLIC_*` เป็นข้อมูลสาธารณะ ห้ามใส่ `SUPABASE_SECRET_KEY` ในตัวแปร `NEXT_PUBLIC_*` ปล่อย `AUTH_INVITE_REDIRECT_URL` ว่างไว้เพื่อใช้ Site URL ที่ตั้งไว้ หากภายหลังเพิ่ม URL สำหรับลิงก์เชิญใน Redirect URLs ของ Supabase ให้กำหนดตัวแปรนี้เป็น URL เดียวกันทุกตัวอักษร

## การสร้าง Tenant Admin คนแรก

ต้องสร้าง Admin คนแรกผ่านคำสั่งหนึ่งครั้ง เพราะยังไม่มี Admin ที่เข้าสู่ระบบเพื่อส่งคำเชิญ:

```powershell
npm.cmd run admin:bootstrap -- --email=admin@example.com --tenant-id=<TENANT_UUID>
```

คำสั่งจะตรวจ tenant และ application ก่อน หากมี Tenant Admin สถานะ active อยู่แล้วจะไม่ทำงาน จากนั้นส่งอีเมลเชิญและบันทึกผู้รับเชิญเป็น Tenant Admin ผู้รับเชิญเปิดลิงก์ไปยัง `/set-password` เพื่อตั้งรหัสผ่าน หลังเข้าสู่ระบบ Admin สามารถเลือกหน่วยงานแล้วกด **เชิญผู้ใช้** เพื่อกำหนดบทบาท Admin, Editor หรือ Viewer ในหน่วยงานนั้น

## การตรวจสิทธิ์

Tenant Admin เปิดโฟลเดอร์แล้วกด **สิทธิ์โฟลเดอร์** เพื่อเลือก **จำกัดผู้เข้าถึง** และระบุผู้ใช้ ผู้ใช้ต้องมีบทบาทในหน่วยงานก่อน และต้องเข้าถึงโฟลเดอร์แม่ทุกชั้นได้ บทบาทในหน่วยงานยังเป็นเพดานของความสามารถ เช่น Viewer ที่ได้รับสิทธิ์ในโฟลเดอร์ยังแก้ไฟล์ไม่ได้

- `filesvc.tenant_users` เก็บสมาชิก tenant และสถานะ Tenant Admin ส่วน `filesvc.user_department_roles` เก็บบทบาทตามหน่วยงานของแต่ละ application ทั้งสองตารางอยู่ใน schema `filesvc` ซึ่งเป็นส่วนส่วนตัว
- คำขอจากเบราว์เซอร์ส่ง Supabase Auth access token ให้ API ตรวจสอบ จากนั้น API โหลดสมาชิก tenant ที่ยัง active และบทบาทตามหน่วยงาน Tenant Admin มีสิทธิ์ Admin ในทุกหน่วยงานของ application ที่กำหนด
- ผู้ใช้ที่มีสิทธิ์ในหน่วยงานจะเห็นไฟล์ของทุกเจ้าของในหน่วยงานนั้น เมื่ออัปโหลด ระบบใช้ Auth user ID ที่ตรวจสอบแล้วเป็น `owner_subject` โดย client เลือกค่าเองไม่ได้ ส่วน API key แบบเดิมยังใช้เงื่อนไข `ownerSubject` ตามเดิม
- Editor แก้ไขไฟล์ในหน่วยงานได้ Viewer อ่านและดาวน์โหลดได้ มีเพียง Tenant Admin ที่ส่งคำเชิญได้
- เว็บแอปผูกกับ `AUTH_APPLICATION_ID` หากแยกเว็บแอป ให้กำหนด application ID ของแต่ละเว็บใน deployment ของตัวเอง ไม่รับ application ID จาก request header ที่ไม่น่าเชื่อถือ

## API สำหรับเชิญและจัดการผู้ใช้

Tenant Admin เปิดเมนู **จัดการผู้ใช้** เพื่อดูสมาชิกและแก้สถานะหรือบทบาทตามหน่วยงาน หน้ารายชื่อเรียก `GET /api/v1/users?page=1` และโหลดเพิ่มครั้งละ 25 คน

`POST /api/v1/users/invite` ใช้ได้เฉพาะ Tenant Admin ที่เข้าสู่ระบบ:

```json
{
  "email": "member@example.com",
  "departmentGrants": [{ "departmentId": "<UUID>", "role": "viewer" }]
}
```

เมื่อสำเร็จคืน `201` พร้อม `userId`, `email` และรายการสิทธิ์ ผู้ใช้ Auth ที่ยืนยันบัญชีแล้วไม่สามารถรับคำเชิญซ้ำผ่าน endpoint นี้

`PATCH /api/v1/users/{userId}` ให้ Tenant Admin เปลี่ยนสิทธิ์ตามหน่วยงานของสมาชิก และ/หรือตั้ง `status` เป็น `active` หรือ `suspended` การระงับสิทธิ์มีผลกับคำขอ API ครั้งถัดไปทันที เพราะระบบตรวจสมาชิกทุกคำขอ endpoint นี้ไม่อนุญาตให้แก้ไขบัญชี Tenant Admin
