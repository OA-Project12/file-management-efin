"use client";
import { invalidateRequest } from "@/components/dms/model";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import { CopyButton, LoadingRows, Notice } from "@/components/dms/common";
import { errorText, formatDate, isDenied } from "@/components/dms/model";
import { useMediaQuery } from "@/components/dms/shell";

type Event = {
  id: string;
  occurredAt: string;
  actorKind: string;
  actorId: string | null;
  action: string;
  outcome: string;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string;
  details: Record<string, unknown>;
};
type Filters = {
  action: string;
  outcome: string;
  actorId: string;
  resourceId: string;
  from: string;
  to: string;
};
const empty: Filters = {
  action: "",
  outcome: "",
  actorId: "",
  resourceId: "",
  from: "",
  to: "",
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actionName = (action: string) =>
  ({
    "file.download_url": "ขอ URL ดาวน์โหลด",
    "file.preview_url": "ขอ URL ดูตัวอย่าง",
    "file.version_download_url": "ขอ URL ดาวน์โหลดเวอร์ชัน",
    "file.version_preview_url": "ขอ URL ดูตัวอย่างเวอร์ชัน",
  })[action] ?? action;
const outcomeName = (outcome: string) =>
  ({ success: "สำเร็จ", denied: "ถูกปฏิเสธ", failure: "ล้มเหลว" })[outcome] ??
  outcome;
const thaiTimestamp = (value: string) =>
  new Date(
    `${value.length === 16 ? `${value}:00` : value}+07:00`,
  ).toISOString();
function safeDetails(details: Record<string, unknown>) {
  return JSON.stringify(
    details,
    (key, value) =>
      /^(password|token|secret|signed.?url|authorization|api.?key)$/i.test(key)
        ? "[ซ่อนข้อมูลลับ]"
        : typeof value === "string" &&
            /^https?:.*[?&](token|signature)=/i.test(value)
          ? "[ซ่อน URL]"
          : value,
    2,
  );
}
export function AuditTrail({
  api,
}: {
  api: (path: string) => Promise<unknown>;
}) {
  const [items, setItems] = useState<Event[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [draft, setDraft] = useState<Filters>(empty),
    [applied, setApplied] = useState<Filters>(empty);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [validation, setValidation] = useState(""),
    [selected, setSelected] = useState<Event | null>(null),
    [filterOpen, setFilterOpen] = useState(false);
  const mobile = useMediaQuery("(max-width:767px)"),
    serial = useRef(0),
    summary = useRef<HTMLDivElement>(null);
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
        for (const key of [
          "action",
          "outcome",
          "actorId",
          "resourceId",
        ] as const)
          if (applied[key].trim()) query.set(key, applied[key].trim());
        if (applied.from) query.set("from", thaiTimestamp(applied.from));
        if (applied.to) query.set("to", thaiTimestamp(applied.to));
        if (next) query.set("cursor", next);
        const response = (await api(`/audit-events?${query}`)) as {
          data: { items: Event[]; nextCursor: string | null };
        };
        if (id === serial.current) {
          setItems((previous) =>
            next
              ? [
                  ...previous,
                  ...response.data.items.filter(
                    (item) => !previous.some((old) => old.id === item.id),
                  ),
                ]
              : response.data.items,
          );
          setCursor(response.data.nextCursor);
        }
      } catch (cause) {
        if (id === serial.current) {
          setError(errorText(cause));
          if (isDenied(cause)) {
            setItems([]);
            setCursor(null);
            setSelected(null);
          }
        }
      } finally {
        if (id === serial.current) setLoading(false);
      }
    },
    [api, applied],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      invalidateRequest(serial);
    };
  }, [load]);
  function apply(event: FormEvent) {
    event.preventDefault();
    let message = "";
    if (draft.action && !/^[a-z][a-z0-9_.]{0,79}$/.test(draft.action.trim()))
      message = "ระบุการกระทำ เช่น file.download_url";
    if (
      [draft.actorId, draft.resourceId].some(
        (value) => value.trim() && !uuid.test(value.trim()),
      )
    )
      message = "รหัสผู้กระทำและทรัพยากรต้องเป็น UUID";
    if (draft.from && draft.to && draft.from >= draft.to)
      message = "เวลาเริ่มต้นต้องอยู่ก่อนเวลาสิ้นสุด";
    if (message) {
      setValidation(message);
      requestAnimationFrame(() => summary.current?.focus());
      return;
    }
    setValidation("");
    setApplied({ ...draft });
    setFilterOpen(false);
  }
  function clear() {
    setDraft(empty);
    setApplied({ ...empty });
    setValidation("");
    setFilterOpen(false);
  }
  const fields = (
    <>
      <label htmlFor="audit-action">
        การกระทำ
        <input
          id="audit-action"
          aria-label="การกระทำ"
          placeholder="เช่น file.download_url"
          value={draft.action}
          onChange={(e) => setDraft({ ...draft, action: e.target.value })}
        />
      </label>
      <label htmlFor="audit-outcome">
        ผลลัพธ์
        <select
          id="audit-outcome"
          aria-label="ผลลัพธ์"
          value={draft.outcome}
          onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
        >
          <option value="">ทุกผลลัพธ์</option>
          <option value="success">สำเร็จ</option>
          <option value="denied">ถูกปฏิเสธ</option>
          <option value="failure">ล้มเหลว</option>
        </select>
      </label>
      <label htmlFor="audit-actor">
        รหัสผู้กระทำ
        <input
          id="audit-actor"
          aria-label="รหัสผู้กระทำ"
          placeholder="Actor UUID"
          value={draft.actorId}
          onChange={(e) => setDraft({ ...draft, actorId: e.target.value })}
        />
      </label>
      <label htmlFor="audit-resource">
        รหัสทรัพยากร
        <input
          id="audit-resource"
          aria-label="รหัสทรัพยากร"
          placeholder="Resource UUID"
          value={draft.resourceId}
          onChange={(e) => setDraft({ ...draft, resourceId: e.target.value })}
        />
      </label>
      <label htmlFor="audit-from">
        ตั้งแต่ (เวลาไทย)
        <input
          id="audit-from"
          aria-label="ตั้งแต่ (เวลาไทย)"
          type="datetime-local"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
      </label>
      <label htmlFor="audit-to">
        ก่อน (เวลาไทย)
        <input
          id="audit-to"
          aria-label="ก่อน (เวลาไทย)"
          type="datetime-local"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
      </label>
      {validation && (
        <div tabIndex={-1} ref={summary}>
          <Notice tone="danger">{validation}</Notice>
        </div>
      )}
      <div className="filter-actions">
        {mobile && (
          <DialogClose asChild>
            <button type="button" className="secondary">
              ยกเลิก
            </button>
          </DialogClose>
        )}
        <button type="button" className="secondary" onClick={clear}>
          ล้างตัวกรอง
        </button>
        <button className="primary" type="submit">
          ใช้ตัวกรอง
        </button>
      </div>
    </>
  );
  return (
    <section className="audit-panel">
      <div className="heading">
        <div>
          <h1>ประวัติการใช้งาน</h1>
          <p>
            เหตุการณ์ใน tenant/application นี้ย้อนหลังสูงสุด 365 วัน · เวลาไทย
            (UTC+7)
          </p>
        </div>
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw aria-hidden="true" />
          โหลดใหม่
        </button>
      </div>
      {mobile ? (
        <button className="secondary" onClick={() => setFilterOpen(true)}>
          <SlidersHorizontal aria-hidden="true" />
          ตัวกรองประวัติ
        </button>
      ) : (
        <form className="audit-filters" onSubmit={apply} noValidate>
          {fields}
        </form>
      )}
      {Object.values(applied).some(Boolean) && (
        <div className="applied-filters">
          {Object.entries(applied)
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <span className="filter-chip" key={key}>
                {key}: {value}
              </span>
            ))}
          <button className="quiet" onClick={clear}>
            ล้างตัวกรอง
          </button>
        </div>
      )}
      {error && (
        <Notice tone="danger">
          {error}
          <button className="secondary" onClick={() => void load()}>
            ลองใหม่
          </button>
        </Notice>
      )}
      {loading && !items.length ? (
        <LoadingRows label="กำลังโหลดประวัติ…" />
      ) : (
        <div className="table-box stack-table" aria-busy={loading}>
          <table>
            <thead>
              <tr>
                <th>เวลา</th>
                <th>การกระทำ</th>
                <th>ผล</th>
                <th>ผู้กระทำ</th>
                <th>ทรัพยากร</th>
                <th>รายละเอียด</th>
              </tr>
            </thead>
            <tbody>
              {items.map((event) => (
                <tr key={event.id}>
                  <td data-label="เวลา">
                    {formatDate(event.occurredAt, true)}
                  </td>
                  <td data-label="การกระทำ">
                    {actionName(event.action)}
                    <small>{event.action}</small>
                  </td>
                  <td data-label="ผล">{outcomeName(event.outcome)}</td>
                  <td data-label="ผู้กระทำ">
                    {event.actorKind}: {event.actorId?.slice(0, 8) ?? "—"}
                  </td>
                  <td data-label="ทรัพยากร">
                    {event.resourceType ?? "—"}:{" "}
                    {event.resourceId?.slice(0, 8) ?? "—"}
                  </td>
                  <td data-label="รายละเอียด">
                    <button
                      className="text-btn"
                      onClick={() => setSelected(event)}
                    >
                      ดูรายละเอียด
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!error && !items.length && (
            <p className="state-panel">ไม่พบเหตุการณ์ตามตัวกรองที่เลือก</p>
          )}
        </div>
      )}
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
      {filterOpen && mobile && (
        <DialogShell
          open
          title="ตัวกรองประวัติ"
          dirty={JSON.stringify(draft) !== JSON.stringify(applied)}
          onOpenChange={(open) => {
            if (!open) {
              setFilterOpen(false);
              setDraft(applied);
              setValidation("");
            }
          }}
        >
          <h2>ตัวกรองประวัติ</h2>
          <p>เลือกเวลาไทย (UTC+7); เวลาสิ้นสุดไม่รวมขอบบน</p>
          <form className="audit-filters" onSubmit={apply} noValidate>
            {fields}
          </form>
        </DialogShell>
      )}
      {selected && (
        <DialogShell
          open
          title="รายละเอียดเหตุการณ์"
          dirty={false}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <section className="audit-detail">
            <h2>รายละเอียดเหตุการณ์</h2>
            <p>
              {actionName(selected.action)} ·{" "}
              {formatDate(selected.occurredAt, true)} น.
            </p>
            <dl>
              <dt>ผลลัพธ์</dt>
              <dd>{outcomeName(selected.outcome)}</dd>
              <dt>ผู้กระทำ</dt>
              <dd>
                {selected.actorKind}: {selected.actorId ?? "—"}
                {selected.actorId && (
                  <CopyButton
                    value={selected.actorId}
                    label="คัดลอกรหัสผู้กระทำ"
                  />
                )}
              </dd>
              <dt>ทรัพยากร</dt>
              <dd>
                {selected.resourceType ?? "—"}: {selected.resourceId ?? "—"}
                {selected.resourceId && (
                  <CopyButton
                    value={selected.resourceId}
                    label="คัดลอกรหัสทรัพยากร"
                  />
                )}
              </dd>
              <dt>Request ID</dt>
              <dd>
                {selected.requestId}
                <CopyButton
                  value={selected.requestId}
                  label="คัดลอก Request ID"
                />
              </dd>
            </dl>
            <h3>ข้อมูลเพิ่มเติม</h3>
            {selected.details && Object.keys(selected.details).length ? (
              <pre>{safeDetails(selected.details)}</pre>
            ) : (
              <p>ไม่มีข้อมูลเพิ่มเติม</p>
            )}
            <DialogClose asChild>
              <button className="secondary">ปิด</button>
            </DialogClose>
          </section>
        </DialogShell>
      )}
    </section>
  );
}
