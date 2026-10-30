"use client";

import { DialogShell } from "@/components/ui/dialog-shell";

import { useEffect, useState } from "react";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
type User = { userId: string; email: string | null; status: string; isTenantAdmin: boolean; departmentGrants: { departmentId: string }[] };
type Props = {
    folderId: string;
    departmentId: string;
    api: Api;
    onClose: () => void;
    onSaved: () => void;
    onNotice: (message: string) => void;
};

export function FolderAccess({ folderId, departmentId, api, onClose, onSaved, onNotice }: Props) {
    const [visibility, setVisibility] = useState<"department" | "restricted">("department");
    const [userIds, setUserIds] = useState<string[]>([]);
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [loadError, setLoadError] = useState("");
    const [saveError, setSaveError] = useState("");
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        let active = true;
        async function load() {
            try {
                const access = (await api(`/folders/${folderId}/access`)) as {
                    data: { visibility: "department" | "restricted"; userIds: string[] };
                };
                const members: User[] = [];
                let page: number | null = 1;
                while (page !== null) {
                    const response = (await api(`/users?page=${page}`)) as { data: { items: User[]; nextPage: number | null } };
                    members.push(...response.data.items);
                    page = response.data.nextPage;
                }
                if (!active) return;
                const eligible = members.filter(
                    (member) =>
                        member.status === "active" &&
                        !member.isTenantAdmin &&
                        member.departmentGrants.some((grant) => grant.departmentId === departmentId),
                );
                setVisibility(access.data.visibility);
                setUserIds(access.data.userIds.filter((id) => eligible.some((member) => member.userId === id)));
                setUsers(eligible);
            } catch (error) {
                if (active) setLoadError(error instanceof Error ? error.message : "โหลดสิทธิ์โฟลเดอร์ไม่สำเร็จ");
            } finally {
                if (active) setLoading(false);
            }
        }
        void load();
        return () => {
            active = false;
        };
    }, [api, departmentId, folderId, revision]);

    async function save() {
        setBusy(true);
        setSaveError("");
        try {
            await api(`/folders/${folderId}/access`, {
                method: "PATCH",
                body: JSON.stringify({ visibility, userIds: visibility === "restricted" ? userIds : [] }),
            });
            onNotice("บันทึกสิทธิ์โฟลเดอร์แล้ว");
            onSaved();
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : "บันทึกสิทธิ์โฟลเดอร์ไม่สำเร็จ");
        } finally {
            setBusy(false);
        }
    }

    return (
        <DialogShell open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="จัดการสิทธิ์โฟลเดอร์">
            <section className="folder-access-dialog">
                <h2>สิทธิ์โฟลเดอร์</h2>
                {loading ? (
                    <p role="status">กำลังโหลดสิทธิ์…</p>
                ) : loadError ? (
                    <div className="state-panel error-state" role="alert"><p>{loadError}</p><button className="secondary" onClick={() => { setLoading(true); setLoadError(""); setRevision((value) => value + 1); }}>ลองใหม่</button></div>
                ) : (
                    <>
                        <label>
                            การมองเห็น{" "}
                            <select
                                value={visibility}
                                onChange={(event) => setVisibility(event.target.value as "department" | "restricted")}
                            >
                                <option value="department">ทุกคนในหน่วยงาน</option>
                                <option value="restricted">จำกัดผู้เข้าถึง</option>
                            </select>
                        </label>
                        {visibility === "restricted" && (
                            <>
                                <p>ผู้ใช้ต้องมีสิทธิ์ระดับหน่วยงานและทุกโฟลเดอร์แม่ด้วย Tenant Admin เข้าถึงได้เสมอ</p>
                                <div className="folder-access-users">
                                    {users.map((user) => (
                                        <label key={user.userId}>
                                            <input
                                                type="checkbox"
                                                checked={userIds.includes(user.userId)}
                                                onChange={(event) =>
                                                    setUserIds((current) =>
                                                        event.target.checked
                                                            ? [...current, user.userId]
                                                            : current.filter((id) => id !== user.userId),
                                                    )
                                                }
                                            />
                                            {user.email ?? user.userId}
                                        </label>
                                    ))}
                                    {users.length === 0 && <p>ไม่มีผู้ใช้ที่ได้รับสิทธิ์ในหน่วยงานนี้</p>}
                                </div>
                            </>
                        )}
                        {saveError && <p className="field-error" role="alert">{saveError}</p>}
                        <div className="folder-access-actions">
                            <button className="secondary" disabled={busy} onClick={onClose}>
                                ยกเลิก
                            </button>
                            <button className="primary" disabled={busy} onClick={() => void save()}>
                                {busy ? "กำลังบันทึก…" : "บันทึก"}
                            </button>
                        </div>
                    </>
                )}
            </section>
        </DialogShell>
    );
}
