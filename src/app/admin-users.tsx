"use client";
import { invalidateRequest } from "@/components/dms/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import { errorText, formatDate, isDenied } from "@/components/dms/model";

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
  onInvite: (departmentId: string) => void;
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
  const [inviteDepartment, setInviteDepartment] = useState("");
  const serial = useRef(0),
    lock = useRef(false);

  const load = useCallback(
    async (targetPage = 1) => {
      const id = ++serial.current;
      setLoading(true);
      setLoadError("");
      try {
        const response = (await api(`/users?page=${targetPage}`)) as {
          data: { items: User[]; nextPage: number | null };
        };
        if (id !== serial.current) return;
        setUsers((previous) =>
          targetPage === 1
            ? response.data.items
            : [...previous, ...response.data.items],
        );
        setPage(response.data.nextPage);
      } catch (error) {
        if (id !== serial.current) return;
        setLoadError(errorText(error));
        if (isDenied(error)) {
          setUsers([]);
          setSelected(null);
          setPage(null);
        }
      } finally {
        if (id === serial.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      invalidateRequest(serial);
    };
  }, [load]);

  function choose(user: User) {
    setSaveError("");
    setSelected(user);
    setGrants(user.departmentGrants.map((grant) => ({ ...grant })));
    setStatus(user.status);
  }

  async function save() {
    if (!selected || lock.current) return;
    lock.current = true;
    setBusy(true);
    setSaveError("");
    try {
      await api(`/users/${selected.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ status, departmentGrants: grants }),
      });
      onNotice("บันทึกสิทธิ์ผู้ใช้แล้ว");
      setSelected(null);
      await load();
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }

  return (
    <div className="users-panel">
      <div className="heading">
        <div>
          <h1>จัดการผู้ใช้</h1>
          <p>สมาชิกและสิทธิ์รายหน่วยงาน</p>
        </div>
        <div className="actions">
          <button
            className="secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" /> โหลดใหม่
          </button>
          <button
            className="primary"
            disabled={!inviteDepartment}
            onClick={() => onInvite(inviteDepartment)}
          >
            เชิญผู้ใช้
          </button>
        </div>
      </div>
      <label className="scope-select" htmlFor="invite-scope">
        หน่วยงานสำหรับคำเชิญ
        <select
          id="invite-scope"
          aria-label="หน่วยงานสำหรับคำเชิญ"
          value={inviteDepartment}
          onChange={(event) => setInviteDepartment(event.target.value)}
        >
          <option value="">เลือกหน่วยงานก่อนเชิญ</option>
          {departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
        <small>ใช้สำหรับคำเชิญ ไม่ได้กรองรายชื่อสมาชิกด้านล่าง</small>
      </label>
      {loadError && (
        <div className="state-panel error-state" role="alert">
          <h2>โหลดรายชื่อผู้ใช้ไม่สำเร็จ</h2>
          <p>{loadError}</p>
          <button className="secondary" onClick={() => void load()}>
            ลองใหม่
          </button>
        </div>
      )}
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
                <td data-label="สถานะ">
                  {user.status === "active" ? "ใช้งาน" : "ระงับ"}
                </td>
                <td data-label="สิทธิ์">
                  {user.isTenantAdmin
                    ? "ผู้ดูแลองค์กร"
                    : user.departmentGrants
                        .map(
                          (grant) =>
                            `${departments.find((d) => d.id === grant.departmentId)?.name ?? grant.departmentId}: ${grant.role}`,
                        )
                        .join(", ") || "ไม่มีสิทธิ์"}
                </td>
                <td data-label="วันที่เพิ่ม">{formatDate(user.createdAt)}</td>
                <td data-label="การดำเนินการ">
                  {user.isTenantAdmin ? (
                    <small>จัดการผ่านช่องทางผู้ดูแลระบบ</small>
                  ) : (
                    <button className="text-btn" onClick={() => choose(user)}>
                      แก้สิทธิ์
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && users.length === 0 && (
          <div className="empty" role="status">
            กำลังโหลดรายชื่อผู้ใช้…
          </div>
        )}
        {!loading && !loadError && users.length === 0 && (
          <div className="empty">ยังไม่มีผู้ใช้ใน tenant นี้</div>
        )}
      </div>
      {page && (
        <button
          className="secondary users-more"
          disabled={loading}
          onClick={() => void load(page)}
        >
          โหลดเพิ่ม
        </button>
      )}
      {selected && (
        <DialogShell
          open={Boolean(selected)}
          busy={busy}
          dirty={
            status !== selected.status ||
            JSON.stringify(grants) !== JSON.stringify(selected.departmentGrants)
          }
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          title="แก้สิทธิ์ผู้ใช้"
        >
          <section className="users-dialog">
            <h2>แก้สิทธิ์ผู้ใช้</h2>
            <p>{selected.email ?? selected.userId}</p>
            <label>
              สถานะ{" "}
              <select
                aria-label="สถานะ"
                value={status}
                onChange={(event) =>
                  setStatus(event.target.value as "active" | "suspended")
                }
              >
                <option value="active">ใช้งาน</option>
                <option value="suspended">ระงับ</option>
              </select>
            </label>
            <p className="form-help">
              ระงับบัญชีจะทำให้เข้าใช้งานไม่ได้
              โดยไม่ล้างสิทธิ์หน่วยงานที่กำหนดไว้
            </p>
            <h3>สิทธิ์ตามหน่วยงาน</h3>
            <p>
              Viewer ดูและดาวน์โหลด, Editor จัดการเอกสาร,
              ผู้ดูแลหน่วยงานส่งคำขอลบถาวรได้
              การจัดการสมาชิกและโควตาเป็นสิทธิ์ผู้ดูแลองค์กร
            </p>
            {departments.map((department) => {
              const grant = grants.find(
                (item) => item.departmentId === department.id,
              );
              return (
                <label key={department.id}>
                  {department.name}
                  <select
                    aria-label={`สิทธิ์ ${department.name}`}
                    value={grant?.role ?? "none"}
                    onChange={(event) => {
                      const role = event.target.value as Role | "none";
                      setGrants((current) =>
                        role === "none"
                          ? current.filter(
                              (item) => item.departmentId !== department.id,
                            )
                          : [
                              ...current.filter(
                                (item) => item.departmentId !== department.id,
                              ),
                              { departmentId: department.id, role },
                            ],
                      );
                    }}
                  >
                    <option value="none">ไม่มีสิทธิ์</option>
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="admin">ผู้ดูแลหน่วยงาน</option>
                  </select>
                </label>
              );
            })}
            {saveError && (
              <p className="field-error" role="alert">
                {saveError}
              </p>
            )}
            <div className="users-actions">
              <DialogClose asChild>
                <button className="secondary" disabled={busy}>
                  ยกเลิก
                </button>
              </DialogClose>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </section>
        </DialogShell>
      )}
    </div>
  );
}
