"use client";
import { useRef, useState, type FormEvent } from "react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import type { Api, Department, Scope, Role } from "./model";
import { errorText } from "./model";
import { Notice } from "./common";

export type Creation = {
  kind: "department" | "folder" | "invite";
  scope: Scope;
  departmentId?: string;
};
export function CreationDialog({
  value,
  api,
  departments,
  onClose,
  onCreated,
}: {
  value: Creation;
  api: Api;
  departments: Department[];
  onClose: () => void;
  onCreated: (kind: Creation["kind"], message: string) => void;
}) {
  const [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<Role>("viewer"),
    [department, setDepartment] = useState(
      value.departmentId || value.scope.departmentId,
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    field = useRef<HTMLInputElement>(null);
  const title =
    value.kind === "department"
      ? "สร้างหน่วยงาน"
      : value.kind === "folder"
        ? "สร้างโฟลเดอร์"
        : "เชิญผู้ใช้";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    setError("");
    if (
      value.kind !== "invite" &&
      (!name.trim() ||
        name.trim().length > 120 ||
        (value.kind === "folder" && /[\\/\u0000-\u001f\u007f]/.test(name)))
    ) {
      setError(
        "ระบุชื่อ 1–120 ตัวอักษร ชื่อโฟลเดอร์ห้าม slash, backslash และอักขระควบคุม",
      );
      field.current?.focus();
      return;
    }
    if (
      value.kind === "invite" &&
      (!department ||
        email.trim().length > 320 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    ) {
      setError("เลือกหน่วยงานและกรอกอีเมลที่ถูกต้อง");
      field.current?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      if (value.kind === "department")
        await api("/departments", {
          method: "POST",
          body: JSON.stringify({ name: name.trim() }),
        });
      else if (value.kind === "folder")
        await api("/folders", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            departmentId: value.scope.departmentId,
            parentFolderId: value.scope.folderId || null,
          }),
        });
      else
        await api("/users/invite", {
          method: "POST",
          body: JSON.stringify({
            email: email.trim(),
            departmentGrants: [{ departmentId: department, role }],
          }),
        });
      onClose();
      onCreated(
        value.kind,
        value.kind === "invite"
          ? `ส่งคำเชิญไปยัง ${email.trim()} สำหรับหน่วยงาน ${departments.find((d) => d.id === department)?.name ?? "ที่เลือก"} แล้ว`
          : `${title}แล้ว`,
      );
    } catch (cause) {
      setError(
        `${errorText(cause)}${value.kind === "invite" ? " · หากไม่ทราบผล ให้ตรวจรายชื่อและผู้รับก่อนส่งอีกครั้ง" : ""}`,
      );
      field.current?.focus();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <DialogShell
      open
      title={title}
      busy={busy}
      dirty={Boolean(
        name ||
          email ||
          role !== "viewer" ||
          department !== (value.departmentId || value.scope.departmentId),
      )}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <h2>{title}</h2>
      <p>
        {value.kind === "department"
          ? "หน่วยงานเป็นขอบเขตคลังและบทบาท"
          : value.kind === "folder"
            ? `สร้างใน ${[departments.find((d) => d.id === value.scope.departmentId)?.name, ...value.scope.path.map((f) => f.name)].filter(Boolean).join(" / ")}`
            : "ผู้รับจะได้รับอีเมลสำหรับตั้งรหัสผ่าน"}
      </p>
      <form onSubmit={submit} noValidate>
        <fieldset disabled={busy}>
          {value.kind === "invite" ? (
            <>
              <label htmlFor="invite-department">
                หน่วยงาน
                <select
                  id="invite-department"
                  aria-label="หน่วยงาน"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  required
                >
                  <option value="">เลือกหน่วยงาน</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="invite-email">
                อีเมลผู้ใช้
                <input
                  id="invite-email"
                  aria-label="อีเมลผู้ใช้"
                  ref={field}
                  type="email"
                  autoComplete="email"
                  maxLength={320}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  aria-describedby={error ? "creation-error" : undefined}
                />
              </label>
              <label htmlFor="invite-role">
                บทบาทในหน่วยงาน
                <select
                  id="invite-role"
                  aria-label="บทบาทในหน่วยงาน"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  <option value="viewer">Viewer · ดูและดาวน์โหลด</option>
                  <option value="editor">Editor · จัดการไฟล์</option>
                  <option value="admin">
                    ผู้ดูแลหน่วยงาน · จัดการเอกสารและลบถาวร
                  </option>
                </select>
              </label>
            </>
          ) : (
            <label htmlFor="creation-name">
              {value.kind === "folder" ? "ชื่อโฟลเดอร์" : "ชื่อหน่วยงาน"}
              <input
                id="creation-name"
                ref={field}
                autoComplete="off"
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                aria-describedby={error ? "creation-error" : undefined}
              />
            </label>
          )}
        </fieldset>
        {error && (
          <div id="creation-error">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
        <div className="dialog-actions">
          <DialogClose asChild>
            <button type="button" className="secondary" disabled={busy}>
              ยกเลิก
            </button>
          </DialogClose>
          <button className="primary" disabled={busy}>
            {busy
              ? "กำลังบันทึก…"
              : value.kind === "invite"
                ? "ส่งคำเชิญ"
                : "สร้าง"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}
