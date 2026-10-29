"use client";

import { useCallback, useEffect, useState } from "react";

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
};

export function AdminUsers({ api, departments, onNotice }: Props) {
    const [users, setUsers] = useState<User[]>([]);
    const [page, setPage] = useState<number | null>(1);
    const [selected, setSelected] = useState<User | null>(null);
    const [grants, setGrants] = useState<Grant[]>([]);
    const [status, setStatus] = useState<"active" | "suspended">("active");
    const [busy, setBusy] = useState(false);

    const load = useCallback(
        async (targetPage = 1) => {
            try {
                const response = (await api(`/users?page=${targetPage}`)) as { data: { items: User[]; nextPage: number | null } };
                setUsers((previous) => (targetPage === 1 ? response.data.items : [...previous, ...response.data.items]));
                setPage(response.data.nextPage);
            } catch (error) {
                onNotice(error instanceof Error ? error.message : "โหลดรายชื่อผู้ใช้ไม่สำเร็จ");
            }
        },
        [api, onNotice],
    );

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void load();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    function choose(user: User) {
        setSelected(user);
        setGrants(user.departmentGrants.map((grant) => ({ ...grant })));
        setStatus(user.status);
    }

    async function save() {
        if (!selected) return;
        setBusy(true);
        try {
            await api(`/users/${selected.userId}`, { method: "PATCH", body: JSON.stringify({ status, departmentGrants: grants }) });
            onNotice("บันทึกสิทธิ์ผู้ใช้แล้ว");
            setSelected(null);
            await load();
        } catch (error) {
            onNotice(error instanceof Error ? error.message : "บันทึกสิทธิ์ไม่สำเร็จ");
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
                <button className="secondary" onClick={() => void load()}>
                    ↻ โหลดใหม่
                </button>
            </div>
            <div className="table-box">
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
                                <td>{user.email ?? user.userId}</td>
                                <td>{user.status === "active" ? "ใช้งาน" : "ระงับ"}</td>
                                <td>
                                    {user.isTenantAdmin
                                        ? "Tenant Admin"
                                        : user.departmentGrants
                                              .map(
                                                  (grant) =>
                                                      `${departments.find((d) => d.id === grant.departmentId)?.name ?? grant.departmentId}: ${grant.role}`,
                                              )
                                              .join(", ") || "ไม่มีสิทธิ์"}
                                </td>
                                <td>{new Date(user.createdAt).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok" })}</td>
                                <td>
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
                {users.length === 0 && <div className="empty">ยังไม่มีผู้ใช้</div>}
            </div>
            {page && (
                <button className="secondary users-more" onClick={() => void load(page)}>
                    โหลดเพิ่ม
                </button>
            )}
            {selected && (
                <div className="modal" role="dialog" aria-modal="true" aria-label="แก้สิทธิ์ผู้ใช้">
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
                        <div className="users-actions">
                            <button className="secondary" disabled={busy} onClick={() => setSelected(null)}>
                                ยกเลิก
                            </button>
                            <button className="primary" disabled={busy} onClick={() => void save()}>
                                {busy ? "กำลังบันทึก…" : "บันทึก"}
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
}
