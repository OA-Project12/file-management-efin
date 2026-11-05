"use client";
import { invalidateRequest } from "@/components/dms/model";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import type { Api, Department, FileRow } from "./model";
import { canWrite, errorText, fileName, formatDate, isDenied } from "./model";
import { FullName, LoadingRows, Notice, StatePanel } from "./common";
import { ScanProgress, scanPending, type ScanReceipt } from "./scan-progress";
import { useUnsavedChanges } from "./navigation-guard";

export function Trash({
  api,
  departments,
  departmentId,
  writeAllowed,
  onDepartment,
  onBack,
  onRefresh,
  onNotice,
}: {
  api: Api;
  departments: Department[];
  departmentId: string;
  writeAllowed: boolean;
  onDepartment: (id: string) => void;
  onBack: () => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [items, setItems] = useState<FileRow[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null),
    [selected, setSelected] = useState<FileRow | null>(null),
    [receipts, setReceipts] = useState<string[]>([]);
  const [scans,setScans] = useState<Record<string,ScanReceipt>>({});
  const serial = useRef(0),
    lock = useRef(false);
  useUnsavedChanges(false, Boolean(busy));
  const load = useCallback(
    async (next: string | null = null) => {
      const id = ++serial.current;
      setLoading(true);
      setError("");
      if (!next) {
        setItems([]);
        setCursor(null);
      }
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (departmentId) query.set("departmentId", departmentId);
        if (next) query.set("cursor", next);
        const response = await api<{
          items: FileRow[];
          nextCursor: string | null;
        }>(`/files/trash?${query}`);
        if (id === serial.current) {
          setItems((previous) =>
            next
              ? [
                  ...previous,
                  ...response.data.items.filter(
                    (row) => !previous.some((old) => old.id === row.id),
                  ),
                ]
              : response.data.items,
          );
          setCursor(response.data.nextCursor);
        }
        return true;
      } catch (cause) {
        if (id === serial.current) {
          setError(errorText(cause));
          if (isDenied(cause)) {
            setItems([]);
            setCursor(null);
          }
        }
        return false;
      } finally {
        if (id === serial.current) setLoading(false);
      }
    },
    [api, departmentId],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      invalidateRequest(serial);
    };
  }, [load]);
  async function action(file: FileRow, kind: "restore" | "purge") {
    if (lock.current) return;
    lock.current = true;
    setBusy(file.id);
    setError("");
    try {
      const response = await api<ScanReceipt>(`/files/${file.id}/${kind}`, { method: "POST", body: "{}" });
      setSelected(null);
      if (kind==="restore" && response.data.scanId) {
        setScans(current=>({...current,[file.id]:response.data}));
        return;
      }
      if (kind === "purge")
        setReceipts((old) => [
          ...old,
          `${fileName(file)} — ส่งคำขอลบถาวรแล้ว การคืนพื้นที่อาจใช้เวลา`,
        ]);
      else onNotice("กู้คืนจากถังขยะแล้ว");
      onRefresh();
      const loaded = await load();
      if (!loaded)
        onNotice(
          `${kind === "purge" ? "ส่งคำขอลบแล้ว" : "กู้คืนสำเร็จ"} แต่โหลดรายการล่าสุดไม่สำเร็จ กรุณารีเฟรช`,
        );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }
  const controls = (file: FileRow) => (
    <div className="actions">
      {scans[file.id] && <ScanProgress api={api} receipt={scans[file.id]} onResult={(result)=>{
        setScans(current=>({...current,[file.id]:result}));
        if (result.status==="available") { onNotice("กู้คืนจากถังขยะแล้ว"); onRefresh(); void load(); }
      }} />}
      {writeAllowed &&
        canWrite(departments.find((d) => d.id === file.departmentId)) && (
          <button
            className="secondary"
            disabled={Boolean(busy) || scanPending(scans[file.id])}
            onClick={() => void action(file, "restore")}
          >
            <RotateCcw aria-hidden="true" />
            กู้คืน
          </button>
        )}
      {writeAllowed &&
        departments.find((d) => d.id === file.departmentId)?.role ===
          "admin" && (
          <button
            className="danger-text"
            disabled={Boolean(busy) || scanPending(scans[file.id])}
            onClick={() => {
              setError("");
              setSelected(file);
            }}
          >
            <Trash2 aria-hidden="true" />
            ลบถาวร
          </button>
        )}
    </div>
  );
  return (
    <section>
      <div className="heading">
        <div>
          <h1>ถังขยะ</h1>
          <p>เอกสารในถังขยะยังใช้พื้นที่จัดเก็บ · เวลาไทย (UTC+7)</p>
        </div>
        <div className="actions">
          <button className="secondary" onClick={onBack}>
            กลับไปไฟล์
          </button>
          <button
            className="secondary"
            disabled={loading || Boolean(busy)}
            onClick={() => void load()}
          >
            <RefreshCw aria-hidden="true" />
            รีเฟรช
          </button>
        </div>
      </div>
      <label className="scope-select" htmlFor="trash-department">
        หน่วยงาน
        <select
          id="trash-department"
          aria-label="หน่วยงาน"
          value={departmentId}
          disabled={Boolean(busy)}
          onChange={(e) => onDepartment(e.target.value)}
        >
          <option value="">ทุกหน่วยงานที่มีสิทธิ์</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {receipts.map((receipt, index) => (
        <Notice
          key={index}
          onClose={() =>
            setReceipts((old) => old.filter((_, i) => i !== index))
          }
        >
          {receipt}
        </Notice>
      ))}
      {error && (
        <Notice tone="danger">
          {error}
          <button className="secondary" onClick={() => void load()}>
            ลองใหม่
          </button>
        </Notice>
      )}
      {loading && !items.length ? (
        <LoadingRows label="กำลังโหลดถังขยะ…" />
      ) : !error && !items.length ? (
        <StatePanel title="ถังขยะว่าง">
          เอกสารที่ย้ายเข้าถังขยะและคุณมีสิทธิ์จะปรากฏที่นี่
        </StatePanel>
      ) : null}
      <div className="table-box stack-table" aria-busy={loading}>
        <table>
          <thead>
            <tr>
              <th>ชื่อเอกสาร</th>
              <th>ชนิด</th>
              <th>หน่วยงาน</th>
              <th>วันที่ลบ</th>
              <th>การดำเนินการ</th>
            </tr>
          </thead>
          <tbody>
            {items.map((file) => (
              <tr key={file.id}>
                <td data-label="ชื่อเอกสาร">
                  <strong className="full-name">{fileName(file)}</strong>
                  <FullName name={fileName(file)} />
                </td>
                <td data-label="ชนิด">{file.contentType}</td>
                <td data-label="หน่วยงาน">
                  {departments.find((d) => d.id === file.departmentId)?.name ??
                    "—"}
                </td>
                <td data-label="วันที่ลบ">
                  {formatDate(file.trashedAt, true)}
                </td>
                <td data-label="การดำเนินการ">{controls(file)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pagination-footer">
        <p role="status">แสดง {items.length} รายการที่โหลดแล้ว</p>
        {cursor && (
          <button
            className="secondary"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            โหลดเพิ่ม
          </button>
        )}
      </div>
      {selected && (
        <DialogShell
          open
          title="ลบไฟล์ถาวร?"
          size="confirm"
          initialFocus="cancel"
          dirty={false}
          busy={Boolean(busy)}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <h2>ลบไฟล์ถาวร?</h2>
          {error && <Notice tone="danger">{error}</Notice>}
          <p className="full-name">{fileName(selected)}</p>
          <p>
            กู้คืนไม่ได้ ระบบจะดำเนินการเบื้องหลังและคืนพื้นที่ภายหลัง
            การส่งคำขอไม่ได้หมายถึงลบเสร็จแล้ว
          </p>
          <div className="dialog-actions">
            <DialogClose asChild>
              <button className="secondary" disabled={Boolean(busy)}>
                ยกเลิก
              </button>
            </DialogClose>
            <button
              className="danger"
              disabled={Boolean(busy)}
              onClick={() => void action(selected, "purge")}
            >
              {busy ? "กำลังส่งคำขอ…" : "ส่งคำขอลบถาวร"}
            </button>
          </div>
        </DialogShell>
      )}
    </section>
  );
}
