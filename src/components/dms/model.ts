export type Role = "viewer" | "editor" | "admin";
export type Department = { id: string; code: string; name: string; role: Role };
export type Folder = {
  id: string;
  name: string;
  departmentId: string;
  parentFolderId: string | null;
};
export type FileRow = {
  id: string;
  displayName?: string;
  originalName?: string;
  contentType: string;
  sizeBytes: string;
  folderId?: string | null;
  departmentId: string;
  department?: string | null;
  tags?: string[];
  createdAt?: string;
  trashedAt?: string;
};
export type Scope = { departmentId: string; folderId: string; path: Folder[] };
export type Tab = "files" | "trash" | "users" | "audit" | "storage" | "keys";
export type Identity = {
  userId: string | null;
  tenantId: string;
  applicationId: string;
  scopes: string[];
  isTenantAdmin: boolean;
  departments: Department[];
};
// /me deliberately has a different wire shape from the data envelopes.
export type Api = <T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
) => Promise<{ data: T }>;
export type ApiError = Error & {
  retryAfter?: number;
  code?: string;
  status?: number;
  details?: Record<string, unknown>;
};
export const emptyScope: Scope = { departmentId: "", folderId: "", path: [] };
export const canWrite = (department?: Department) =>
  department?.role === "editor" || department?.role === "admin";
export const roleLabel = (role: Role) =>
  ({ viewer: "Viewer", editor: "Editor", admin: "ผู้ดูแลหน่วยงาน" })[role];
export const fileName = (file: FileRow) =>
  file.displayName || file.originalName || "เอกสาร";
export const formatDate = (value?: string, time = false) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("th-TH", {
        timeZone: "Asia/Bangkok",
        dateStyle: "medium",
        ...(time ? { timeStyle: "short" as const } : {}),
      }).format(new Date(value))
    : "—";
export function fileSize(value: string | number) {
  const bytes = BigInt(value || 0);
  for (const [unit, divisor] of [
    ["GB", BigInt(1000000000)],
    ["MB", BigInt(1000000)],
    ["KB", BigInt(1000)],
  ] as const) {
    if (bytes >= divisor)
      return `${bytes / divisor}.${((bytes % divisor) * BigInt(10)) / divisor} ${unit}`;
  }
  return `${bytes} B`;
}
const messages: Record<string, string> = {
  unauthorized: "การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่",
  forbidden: "คุณไม่มีสิทธิ์ทำรายการนี้",
  department_forbidden: "คุณไม่มีสิทธิ์ทำรายการนี้ในหน่วยงานปลายทาง",
  file_not_found: "ไม่พบรายการนี้ในขอบเขตที่คุณเข้าถึงได้",
  folder_not_found: "ไม่พบรายการนี้ในขอบเขตที่คุณเข้าถึงได้",
  file_or_folder_not_found: "ไม่พบรายการนี้ในขอบเขตที่คุณเข้าถึงได้",
  invalid_search_query:
    "ใช้คำค้นไม่เกิน 200 หน่วยอักขระ และไม่เกิน 10 คำที่คั่นด้วยช่องว่าง",
  invalid_cursor: "รายการเปลี่ยนแล้ว กรุณาเริ่มแสดงจากรายการแรก",
  folder_name_conflict: "ชื่อนี้ถูกใช้แล้วในตำแหน่งนี้",
  department_name_conflict: "มีหน่วยงานชื่อนี้แล้ว กรุณาใช้ชื่ออื่น",
  preview_not_supported:
    "ไฟล์ชนิดนี้ยังดูตัวอย่างไม่ได้ คุณดาวน์โหลดเพื่อเปิดในโปรแกรมที่รองรับได้",
  file_too_large: "ไฟล์เกินขนาดที่ระบบอนุญาต กรุณาตรวจขนาดไฟล์",
  upload_intent_expired: "คำขออัปโหลดหมดอายุ โปรดตรวจรายการก่อนเริ่มใหม่",
  upload_size_exceeds_reservation:
    "ขนาดจริงเกินพื้นที่ที่จอง ยังยืนยันไฟล์ไม่ได้",
  department_quota_exceeded:
    "พื้นที่หน่วยงานปลายทางไม่พอ กรุณาติดต่อผู้ดูแลหรือรอให้การลบถาวรเสร็จ",
  storage_maintenance:
    "ระบบพักการเปลี่ยนแปลงชั่วคราว คุณยังค้นหาและเปิดดูเอกสารได้ โปรดลองภายหลัง",
  rate_limited: "ส่งคำขอถี่เกินไป กรุณารอก่อนลองใหม่",
  request_timeout: "ใช้เวลาอ่านคำขอนานเกินไป กรุณาลองใหม่",
  request_too_large: "ข้อมูลคำขอมีขนาดใหญ่เกินกำหนด กรุณาลดขนาดข้อมูล",
  unsupported_media_type: "กรุณาส่งข้อมูลคำขอในรูปแบบ JSON",
  security_control_unavailable: "ระบบตรวจความปลอดภัยไม่พร้อมใช้งาน กรุณาลองภายหลัง",
  file_type_not_allowed: "รับเฉพาะไฟล์ PDF, JPG/JPEG และ PNG กรุณาเลือกไฟล์ที่รองรับ",
  file_signature_invalid: "ไฟล์ไม่ผ่านการตรวจประเภท กรุณาตรวจไฟล์แล้วอัปโหลดใหม่",
  file_type_mismatch: "เนื้อหาไฟล์ไม่ตรงกับนามสกุลหรือ MIME กรุณาแก้ไฟล์แล้วอัปโหลดใหม่",
  file_validation_unavailable: "ตรวจประเภทไฟล์ไม่ได้ชั่วคราว ไฟล์ยังไม่พร้อมใช้งาน กรุณาลองยืนยันอีกครั้งภายในอายุคำขอ",
  object_changed: "ข้อมูลไฟล์เปลี่ยนระหว่างตรวจ กรุณาตรวจรายการก่อนลองใหม่",
  malware_scan_paused: "ระบบพักการอัปโหลดและกู้คืนชั่วคราว กรุณาลองภายหลัง",
  scan_in_progress: "กำลังตรวจไฟล์หรือรอจัดการไฟล์ที่ถูกกัก",
  service_unavailable: "ยังดำเนินการไม่ได้ โปรดตรวจผลก่อนส่งอีกครั้ง",
  audit_unavailable: "บันทึกประวัติไม่สำเร็จ โปรดตรวจผลก่อนส่งอีกครั้ง",
  admin_protected: "บัญชีผู้ดูแลองค์กรต้องจัดการผ่านช่องทางเฉพาะ",
  invite_failed:
    "ส่งคำเชิญไม่สำเร็จ กรุณาตรวจอีเมลและรายชื่อสมาชิกก่อนส่งอีกครั้ง",
  invalid_users:
    "ผู้ใช้ต้องมีสิทธิ์หน่วยงานและโฟลเดอร์แม่ กรุณาตรวจสิทธิ์ในโฟลเดอร์แม่",
  cannot_revoke_current_key:
    "เพิกถอนคีย์ที่กำลังใช้จัดการไม่ได้ กรุณาใช้ช่องทาง management key อื่น",
};
export function errorText(error: unknown) {
  const value = error as ApiError;
  if (value?.code === "rate_limited" && Number.isFinite(value.retryAfter) && value.retryAfter! > 0)
    return `ส่งคำขอถี่เกินไป กรุณารอ ${value.retryAfter} วินาทีก่อนลองใหม่`;
  if (value?.code)
    return (
      messages[value.code] ?? "ดำเนินการไม่สำเร็จ กรุณาตรวจข้อมูลและลองใหม่"
    );
  if (error instanceof TypeError)
    return "เชื่อมต่อระบบไม่ได้ กรุณาตรวจเครือข่ายแล้วลองใหม่";
  return "ดำเนินการไม่สำเร็จ กรุณาตรวจผลก่อนทำรายการอีกครั้ง";
}
export const isDenied = (error: unknown) =>
  [401, 403, 404].includes((error as ApiError)?.status ?? 0);

export function invalidateRequest(sequence: { current: number }) {
  sequence.current++;
}
