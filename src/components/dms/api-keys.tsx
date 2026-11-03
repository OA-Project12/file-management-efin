"use client";
import { invalidateRequest } from "@/components/dms/model";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import { CopyButton, LoadingRows, Notice, StatePanel } from "./common";
import type { Api, Department, Role } from "./model";
import { errorText, formatDate, isDenied, roleLabel } from "./model";
import { useNavigationGuard, useUnsavedChanges } from "./navigation-guard";

type Key = {
  id: string;
  keyPrefix: string;
  scopes: string[];
  departmentGrants: Department[];
  expiresAt: string | null;
  createdAt?: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
export function ApiKeys({
  api,
  departments,
  onNotice,
}: {
  api: Api;
  departments: Department[];
  onNotice: (message: string) => void;
}) {
  const [checkedAt, setCheckedAt] = useState(0);
  const [items, setItems] = useState<Key[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [form, setForm] = useState(false),
    [days, setDays] = useState("90"),
    [scopes, setScopes] = useState(["files:read"]),
    [grants, setGrants] = useState<Record<string, Role>>({});
  const [busy, setBusy] = useState(false),
    [secret, setSecret] = useState(""),
    [ack, setAck] = useState(false),
    [closeWarning, setCloseWarning] = useState(false),
    [revoke, setRevoke] = useState<Key | null>(null);
  const { navigate } = useNavigationGuard();
  const lock = useRef(false),
    serial = useRef(0),
    ackInput = useRef<HTMLInputElement>(null);
  const dirty =
    form &&
    (days !== "90" ||
      scopes.length !== 1 ||
      scopes[0] !== "files:read" ||
      Object.keys(grants).length > 0);
  useUnsavedChanges(dirty, busy || Boolean(secret));
  const load = useCallback(async () => {
    const id = ++serial.current;
    setLoading(true);
    try {
      const response = await api<{ items: Key[] }>("/keys");
      if (id === serial.current) {
        setItems(response.data.items);
        setCheckedAt(Date.now());
      }
      return true;
    } catch (cause) {
      if (id === serial.current) {
        setError(errorText(cause));
        if (isDenied(cause)) setItems([]);
      }
      return false;
    } finally {
      if (id === serial.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      invalidateRequest(serial);
    };
  }, [load]);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    setError("");
    const age = Number(days);
    if (
      !Number.isInteger(age) ||
      age < 1 ||
      age > 365 ||
      !scopes.length ||
      !Object.keys(grants).length ||
      Object.keys(grants).length > 100
    ) {
      setError("ระบุอายุ 1–365 วัน เลือก scope และอย่างน้อยหนึ่งหน่วยงาน");
      return;
    }
    if (
      scopes.includes("keys:manage") &&
      Object.values(grants).some((role) => role !== "admin")
    ) {
      setError("keys:manage ต้องมีบทบาทผู้ดูแลหน่วยงานในทุกหน่วยงานที่เลือก");
      return;
    }
    lock.current = true;
    setBusy(true);
    try {
      const response = await api<{ apiKey: string }>("/keys", {
        method: "POST",
        body: JSON.stringify({
          expiresInDays: age,
          scopes,
          departmentGrants: Object.entries(grants).map(
            ([departmentId, role]) => ({ departmentId, role }),
          ),
        }),
      });
      setSecret(response.data.apiKey);
      setAck(false);
      setCloseWarning(false);
      setForm(false);
      setDays("90");
      setScopes(["files:read"]);
      setGrants({});
      void load();
    } catch (cause) {
      setError(`${errorText(cause)} · หากไม่ทราบผล ให้ตรวจรายการก่อนสร้างใหม่`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function closeSecret(force = false) {
    if (!ack && !force) {
      setCloseWarning(true);
      requestAnimationFrame(() => ackInput.current?.focus());
      return;
    }
    setSecret("");
    setAck(false);
    setCloseWarning(false);
  }
  async function remove() {
    if (!revoke || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/keys/${revoke.id}`, { method: "DELETE" });
      setRevoke(null);
      onNotice("เพิกถอนคีย์แล้ว");
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="heading">
        <div>
          <h1>API keys</h1>
          <p>คีย์สำหรับระบบที่เชื่อถือได้ · วันเวลาไทย (UTC+7)</p>
        </div>
        <button
          className="primary"
          aria-expanded={form}
          onClick={() =>
            form ? navigate(() => setForm(false)) : setForm(true)
          }
        >
          {form ? "ปิดฟอร์ม" : "สร้าง API key"}
        </button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {form && (
        <form className="key-form panel" onSubmit={create}>
          <h2>สร้าง API key</h2>
          <fieldset disabled={busy}>
            <label htmlFor="key-days">
              อายุ (วัน)
              <input
                id="key-days"
                inputMode="numeric"
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </label>
            <fieldset>
              <legend>Scopes</legend>
              {["files:read", "files:write", "keys:manage"].map((scope) => (
                <label className="checkbox-label" key={scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes((old) =>
                        e.target.checked
                          ? [...old, scope]
                          : old.filter((value) => value !== scope),
                      )
                    }
                  />
                  {scope}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>สิทธิ์ตามหน่วยงาน</legend>
              {departments.map((d) => (
                <label key={d.id}>
                  {d.name}
                  <select
                    aria-label={`บทบาทคีย์ ${d.name}`}
                    value={grants[d.id] ?? "none"}
                    onChange={(e) =>
                      setGrants((old) => {
                        const next = { ...old };
                        if (e.target.value === "none") delete next[d.id];
                        else next[d.id] = e.target.value as Role;
                        return next;
                      })
                    }
                  >
                    <option value="none">ไม่ให้สิทธิ์</option>
                    {(["viewer", "editor", "admin"] as Role[])
                      .filter(
                        (role) =>
                          ["viewer", "editor", "admin"].indexOf(role) <=
                          ["viewer", "editor", "admin"].indexOf(d.role),
                      )
                      .map((role) => (
                        <option key={role} value={role}>
                          {roleLabel(role)}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </fieldset>
          </fieldset>
          <p className="muted">
            Secret จะแสดงครั้งเดียว กรุณาจัดเก็บในที่ปลอดภัยก่อนปิด
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => navigate(() => setForm(false))}
            >
              ยกเลิก
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "กำลังสร้าง…" : "สร้าง key"}
            </button>
          </div>
        </form>
      )}
      {loading && !items.length ? (
        <LoadingRows label="กำลังโหลด API key…" />
      ) : !items.length && !error ? (
        <StatePanel title="ยังไม่มี API key" />
      ) : (
        <div className="table-box stack-table">
          <table>
            <thead>
              <tr>
                <th>Key prefix</th>
                <th>Scopes / หน่วยงาน</th>
                <th>สร้าง / หมดอายุ</th>
                <th>สถานะ</th>
                <th>การดำเนินการ</th>
              </tr>
            </thead>
            <tbody>
              {items.map((key) => (
                <tr key={key.id}>
                  <td data-label="Key prefix">
                    <code>{key.keyPrefix}</code>
                  </td>
                  <td data-label="Scopes / หน่วยงาน">
                    {key.scopes.join(", ")}
                    <small>
                      {key.departmentGrants
                        ?.map((d) => `${d.name}: ${roleLabel(d.role)}`)
                        .join(", ")}
                    </small>
                  </td>
                  <td data-label="สร้าง / หมดอายุ">
                    {formatDate(key.createdAt)} /{" "}
                    {key.expiresAt ? formatDate(key.expiresAt) : "ไม่กำหนด"}
                  </td>
                  <td data-label="สถานะ">
                    {key.revokedAt
                      ? "เพิกถอนแล้ว"
                      : key.expiresAt && Date.parse(key.expiresAt) <= checkedAt
                        ? "หมดอายุ"
                        : "ใช้งาน"}
                  </td>
                  <td data-label="การดำเนินการ">
                    {!key.revokedAt && (
                      <button
                        className="danger-text"
                        onClick={() => {
                          setError("");
                          setRevoke(key);
                        }}
                      >
                        เพิกถอน
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button
        className="secondary"
        disabled={loading}
        onClick={() => {
          setError("");
          void load();
        }}
      >
        รีเฟรชคีย์
      </button>
      {secret && (
        <DialogShell
          open
          title="จัดเก็บ API key"
          dirty={false}
          onOpenChange={(open) => {
            if (!open) closeSecret();
          }}
        >
          <h2>จัดเก็บ API key</h2>
          <p>
            คีย์นี้เปิดดูย้อนหลังไม่ได้ เมื่อปิดหน้าต่างหรือ browser
            ค่านี้จะหายไป
          </p>
          <pre className="secret-value" tabIndex={0}>
            {secret}
          </pre>
          <CopyButton value={secret} label="คัดลอกคีย์" />
          <label className="checkbox-label">
            <input
              type="checkbox"
              ref={ackInput}
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            ฉันจัดเก็บคีย์นี้แล้ว
          </label>
          {closeWarning && (
            <Notice tone="warning">
              โปรดจัดเก็บคีย์ก่อนปิด หรือยืนยันปิดโดยตั้งใจ
            </Notice>
          )}
          <div className="dialog-actions">
            <button className="primary" onClick={() => closeSecret()}>
              เสร็จสิ้น
            </button>
            {closeWarning && (
              <button className="danger-text" onClick={() => closeSecret(true)}>
                ยืนยันปิดโดยยังไม่ได้เก็บ
              </button>
            )}
          </div>
        </DialogShell>
      )}
      {revoke && (
        <DialogShell
          open
          title="เพิกถอน API key?"
          size="confirm"
          dirty={false}
          busy={busy}
          initialFocus="cancel"
          onOpenChange={(open) => {
            if (!open) setRevoke(null);
          }}
        >
          <h2>เพิกถอน API key?</h2>
          {error && <Notice tone="danger">{error}</Notice>}
          <code>{revoke.keyPrefix}</code>
          <p>ระบบที่ใช้คีย์นี้จะเรียก API ไม่ได้</p>
          <div className="dialog-actions">
            <DialogClose asChild>
              <button className="secondary" disabled={busy}>
                ยกเลิก
              </button>
            </DialogClose>
            <button
              className="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? "กำลังเพิกถอน…" : "เพิกถอนคีย์"}
            </button>
          </div>
        </DialogShell>
      )}
    </section>
  );
}
