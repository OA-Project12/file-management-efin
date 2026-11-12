"use client";
import { useRef, useState, type FormEvent } from "react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import type { Api, Department, Scope, Role } from "./model";
import { errorText } from "./model";
import { Notice } from "./common";

export type Creation = { kind: "department" | "invite" } | { kind: "folder"; scope: Scope };
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
        [department, setDepartment] = useState("");
    const [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const [invalidField, setInvalidField] = useState<"department" | "email" | null>(null);
    const lock = useRef(false),
        field = useRef<HTMLInputElement>(null);
    const departmentField = useRef<HTMLSelectElement>(null);
    const noInviteDepartments = value.kind === "invite" && departments.length === 0;
    const title = value.kind === "department" ? "สร้างหน่วยงาน" : value.kind === "folder" ? "สร้างโฟลเดอร์" : "เชิญผู้ใช้";
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (lock.current || noInviteDepartments) return;
        setError("");
        setInvalidField(null);
        if (
            value.kind !== "invite" &&
            (!name.trim() || name.trim().length > 120 || (value.kind === "folder" && /[\\/\u0000-\u001f\u007f]/.test(name)))
        ) {
            setError("ระบุชื่อ 1–120 ตัวอักษร ชื่อโฟลเดอร์ห้าม slash, backslash และอักขระควบคุม");
            field.current?.focus();
            return;
        }
        if (value.kind === "invite") {
            if (!departments.some(({ id }) => id === department)) {
                setInvalidField("department");
                departmentField.current?.focus();
                return;
            }
            if (email.trim().length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
                setInvalidField("email");
                field.current?.focus();
                return;
            }
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
            setError(`${errorText(cause)}${value.kind === "invite" ? " · หากไม่ทราบผล ให้ตรวจรายชื่อและผู้รับก่อนส่งอีกครั้ง" : ""}`);
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
            dirty={Boolean(name || email || role !== "viewer" || department)}
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
                                    ref={departmentField}
                                    value={department}
                                    onChange={(e) => {
                                        setDepartment(e.target.value);
                                        if (invalidField === "department") setInvalidField(null);
                                    }}
                                    disabled={noInviteDepartments}
                                    aria-invalid={invalidField === "department" || undefined}
                                    aria-describedby={invalidField === "department" ? "invite-department-error" : undefined}
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
                            {invalidField === "department" && (
                                <div id="invite-department-error">
                                    <Notice tone="danger">กรุณาเลือกหน่วยงาน</Notice>
                                </div>
                            )}
                            {noInviteDepartments && <Notice tone="warning">ยังไม่มีหน่วยงานสำหรับส่งคำเชิญ</Notice>}
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
                                    onChange={(e) => {
                                        setEmail(e.target.value);
                                        if (invalidField === "email") setInvalidField(null);
                                    }}
                                    required
                                    aria-invalid={invalidField === "email" || undefined}
                                    aria-describedby={invalidField === "email" ? "invite-email-error" : undefined}
                                />
                            </label>
                            {invalidField === "email" && (
                                <div id="invite-email-error">
                                    <Notice tone="danger">กรุณากรอกอีเมลที่ถูกต้อง</Notice>
                                </div>
                            )}
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
                                    <option value="admin">ผู้ดูแลหน่วยงาน · จัดการเอกสารและลบถาวร</option>
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
                    <button className="primary" disabled={busy || noInviteDepartments}>
                        {busy ? "กำลังบันทึก…" : value.kind === "invite" ? "ส่งคำเชิญ" : "สร้าง"}
                    </button>
                </div>
            </form>
        </DialogShell>
    );
}
