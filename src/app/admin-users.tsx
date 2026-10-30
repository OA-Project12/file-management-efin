"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { DialogShell } from "@/components/ui/dialog-shell";

type Role = "admin" | "editor" | "viewer";
type Department = { id: string; name: string };
type Grant = { departmentId: string; role: Role };
type User = {
    userId: string;
    email: string | null;
    status: "active" | "suspended";
    isTenantAdmin: boolean;
    createdAt: string;
    departmentGrants: Grant[];
};
type Props = {
    api: (path: string, init?: RequestInit) => Promise<unknown>;
    departments: Department[];
    onNotice: (message: string) => void;
    onInvite: () => void;
};

export function AdminUsers({ api, departments, onNotice, onInvite }: Props) {
    const [users, setUsers] = useState<User[]>([]);
    const [page, setPage] = useState<number | null>(1);
    const [selected, setSelected] = useState<User | null>(null);
    const [grants, setGrants] = useState<Grant[]>([]);
    const [status, setStatus] = useState<"active" | "suspended">("active");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");

    const load = useCallback(
        async (targetPage = 1) => {
            setLoading(true);
            setLoadError("");
            try {
                const response = (await api(`/users?page=${targetPage}`)) as { data: { items: User[]; nextPage: number | null } };
                setUsers((previous) => (targetPage === 1 ? response.data.items : [...previous, ...response.data.items]));
                setPage(response.data.nextPage);
            } catch (error) {
                setLoadError(error instanceof Error ? error.message : "โหลดรายชื่อผู้ใช้ไม่สำเร็จ");
            } finally {
                setLoading(false);
            }
        },
        [api],
    );

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void load();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    function choose(user: User) {
        setSaveError("");
        setSelected(user);
        setGrants(user.departmentGrants.map((grant) => ({ ...grant })));
        setStatus(user.status);
    }

    async function save() {
        if (!selected) return;
        setBusy(true);
        setSaveError("");
        try {
            await api(`/users/${selected.userId}`, { method: "PATCH", body: JSON.stringify({ status, departmentGrants: grants }) });
            onNotice("บันทึกสิทธิ์ผู้ใช้แล้ว");
            setSelected(null);
            await load();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "บันทึกสิทธิ์ไม่สำเร็จ");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="users-panel">
            <div className="heading">
                <div>
                    <h1>จัดการผู้ใช้</h1>
                    <p>สมาชิกและสิทธิ์รายหน่วยงาน</p>
                </div>
                <div className="actions"><button className="secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={17} aria-hidden="true" /> โหลดใหม่</button><button className="primary" onClick={onInvite}>เชิญผู้ใช้</button></div>
            </div>
            {loadError && <div className="state-panel error-state" role="alert"><h2>โหลดรายชื่อผู้ใช้ไม่สำเร็จ</h2><p>{loadError}</p><button className="secondary" onClick={() => void load()}>ลองใหม่</button></div>}
            <div className="table-box stack-table" aria-busy={loading}>
                <table>
                    <thead>
                        <tr>
                            <th>อีเมล</th>
                            <th>สถานะ</th>
                            <th>สิทธิ์</th>
                            <th>วันที่เพิ่ม</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr key={user.userId}>
                                <td data-label="อีเมล">{user.email ?? user.userId}</td>
                                <td data-label="สถานะ">{user.status === "active" ? "ใช้งาน" : "ระงับ"}</td>
                                <td data-label="สิทธิ์">
                                    {user.isTenantAdmin
                                        ? "Tenant Admin"
                                        : user.departmentGrants
                                              .map(
                                                  (grant) =>
                                                      `${departments.find((d) => d.id === grant.departmentId)?.name ?? grant.departmentId}: ${grant.role}`,
                                              )
                                              .join(", ") || "ไม่มีสิทธิ์"}
                                </td>
                                <td data-label="วันที่เพิ่ม">{new Date(user.createdAt).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok" })}</td>
                                <td data-label="การดำเนินการ">
                                    {!user.isTenantAdmin && (
                                        <button className="text-btn" onClick={() => choose(user)}>
                                            แก้สิทธิ์
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {loading && users.length === 0 && <div className="empty" role="status">กำลังโหลดรายชื่อผู้ใช้…</div>}
                {!loading && !loadError && users.length === 0 && <div className="empty">ยังไม่มีผู้ใช้ใน tenant นี้</div>}
            </div>
            {page && (
                <button className="secondary users-more" disabled={loading} onClick={() => void load(page)}>
                    โหลดเพิ่ม
                </button>
            )}
            {selected && (
                <DialogShell open={Boolean(selected)} onOpenChange={(open) => { if (!open && !busy) setSelected(null); }} title="แก้สิทธิ์ผู้ใช้">
                    <section className="users-dialog">
                        <h2>แก้สิทธิ์ผู้ใช้</h2>
                        <p>{selected.email ?? selected.userId}</p>
                        <label>
                            สถานะ{" "}
                            <select value={status} onChange={(event) => setStatus(event.target.value as "active" | "suspended")}>
                                <option value="active">ใช้งาน</option>
                                <option value="suspended">ระงับ</option>
                            </select>
                        </label>
                        <h3>สิทธิ์ตามหน่วยงาน</h3>
                        <p>Viewer ดูไฟล์, Editor จัดการไฟล์, Admin จัดการไฟล์และสิทธิ์ในหน่วยงาน</p>
                        {departments.map((department) => {
                            const grant = grants.find((item) => item.departmentId === department.id);
                            return (
                                <label key={department.id}>
                                    {department.name}
                                    <select
                                        value={grant?.role ?? "none"}
                                        onChange={(event) => {
                                            const role = event.target.value as Role | "none";
                                            setGrants((current) =>
                                                role === "none"
                                                    ? current.filter((item) => item.departmentId !== department.id)
                                                    : [
                                                          ...current.filter((item) => item.departmentId !== department.id),
                                                          { departmentId: department.id, role },
                                                      ],
                                            );
                                        }}
                                    >
                                        <option value="none">ไม่มีสิทธิ์</option>
                                        <option value="viewer">Viewer</option>
                                        <option value="editor">Editor</option>
                                        <option value="admin">Admin</option>
                                    </select>
                                </label>
                            );
                        })}
                        {saveError && <p className="field-error" role="alert">{saveError}</p>}
                        <div className="users-actions">
                            <button className="secondary" disabled={busy} onClick={() => setSelected(null)}>
                                ยกเลิก
                            </button>
                            <button className="primary" disabled={busy} onClick={() => void save()}>
                                {busy ? "กำลังบันทึก…" : "บันทึก"}
                            </button>
                        </div>
                    </section>
                </DialogShell>
            )}
        </div>
    );
}
