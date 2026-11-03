"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  HardDrive,
  Info,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  exactQuotaAmount,
  formatQuotaBytes,
  parseQuotaAmount,
  quotaCapacityStatus,
  type QuotaUnit,
} from "@/domain/storage/quota-presentation";
import type { StorageQuotaItem } from "@/application/storage/manage-department-quotas";

type Api = (path: string, init?: RequestInit) => Promise<{ data: unknown }>;
type ApiError = Error & { code?: string; status?: number };
const dateFormat = new Intl.DateTimeFormat("th-TH", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Bangkok",
});
function errorText(error: unknown) {
  const code = (error as ApiError)?.code;
  if (
    code === "department_quota_forbidden" ||
    (error as ApiError)?.status === 403
  )
    return "คุณไม่มีสิทธิ์ดูหรือจัดการพื้นที่จัดเก็บ กรุณาติดต่อ ผู้ดูแลองค์กร";
  if (code === "storage_maintenance")
    return "ระบบกำลังตรวจสอบพื้นที่ กรุณาลองใหม่ภายหลัง";
  if (code === "quota_accounting_not_ready")
    return "หน่วยงานนี้ยังรอตรวจสอบยอดพื้นที่ จึงตั้งเพดานแบบจำกัดไม่ได้";
  if (code === "quota_limit_below_committed")
    return "เพดานต้องไม่น้อยกว่าพื้นที่ใช้แล้วรวมพื้นที่จอง กรุณาตรวจสอบยอดล่าสุด";
  if (code === "department_quota_not_found")
    return "ไม่พบหน่วยงานหรือสิทธิ์เข้าถึงหน่วยงานนี้แล้ว กรุณาโหลดข้อมูลใหม่";
  if ((error as ApiError)?.status === 401)
    return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง";
  return "ไม่สามารถติดต่อระบบพื้นที่จัดเก็บได้ กรุณาลองใหม่";
}
function Capacity({ item }: { item: StorageQuotaItem }) {
  const status = quotaCapacityStatus(item);
  const limit = BigInt(item.limitBytes ?? "0"),
    used = BigInt(item.usedBytes ?? "0"),
    reserved = BigInt(item.reservedBytes ?? "0");
  const usedPoints =
    limit > BigInt(0)
      ? Number(
          (used * BigInt(10000)) / limit > BigInt(10000)
            ? BigInt(10000)
            : (used * BigInt(10000)) / limit,
        )
      : 0;
  const reservedRatio =
    limit > BigInt(0) ? (reserved * BigInt(10000)) / limit : BigInt(0);
  const reservePoints = Number(
    reservedRatio > BigInt(10000 - usedPoints)
      ? BigInt(10000 - usedPoints)
      : reservedRatio,
  );
  const finite = item.accountingStatus === "ready" && item.limitBytes !== null;
  return (
    <div className="quota-capacity">
      <Badge variant="outline" className={`quota-status quota-${status.kind}`}>
        {status.kind === "full" && item.limitBytes === "0"
          ? "เต็ม — เพดาน 0 bytes"
          : status.label}
      </Badge>
      {finite && (
        <>
          <div
            className="quota-meter"
            role="meter"
            aria-label={`พื้นที่ใช้แล้วและจองของ ${item.departmentName}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPoints / 100 + reservePoints / 100}
            aria-valuetext={`ใช้แล้ว ${formatQuotaBytes(item.usedBytes)} จอง ${formatQuotaBytes(item.reservedBytes)} จาก ${formatQuotaBytes(item.limitBytes)} · ${status.label}`}
          >
            <span
              className="quota-used"
              style={{ width: `${usedPoints / 100}%` }}
            />
            <span
              className="quota-reserved"
              style={{ width: `${reservePoints / 100}%` }}
            />
          </div>
          <small>
            ใช้และจอง {formatQuotaBytes(item.committedBytes)} /{" "}
            {formatQuotaBytes(item.limitBytes)}
          </small>
        </>
      )}
    </div>
  );
}
function Bytes({ value }: { value: string | null }) {
  return (
    <span
      className="quota-number"
      title={value === null ? undefined : `${value} bytes`}
    >
      {formatQuotaBytes(value)}
    </span>
  );
}

export function StorageQuotas({ api }: { api: Api }) {
  const [items, setItems] = useState<StorageQuotaItem[]>([]),
    [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [success, setSuccess] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null),
    [selected, setSelected] = useState<StorageQuotaItem | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  function openEditor(item: StorageQuotaItem, target: HTMLElement) {
    opener.current = target;
    setSuccess("");
    setSelected(item);
  }
  function closeEditor() {
    setSelected(null);
    requestAnimationFrame(() => opener.current?.focus());
  }
  const requestId = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const id = ++requestId.current;
      setLoading(true);
      setError("");
      try {
        const response = await api("/departments/storage-quotas", { signal });
        const next = (response.data as { items: StorageQuotaItem[] }).items;
        if (id === requestId.current && !signal?.aborted) {
          setItems(next);
          setFilter((current) =>
            !current || next.some((row) => row.departmentId === current)
              ? current
              : "",
          );
          setUpdatedAt(new Date());
        }
        return next;
      } catch (cause) {
        if (id === requestId.current && !signal?.aborted) {
          setError(errorText(cause));
          if ([401, 403].includes((cause as ApiError)?.status ?? 0)) {
            setItems([]);
            setSelected(null);
            setSuccess("");
          }
        }
        throw cause;
      } finally {
        if (id === requestId.current && !signal?.aborted) setLoading(false);
      }
    },
    [api],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void load(controller.signal).catch(() => {});
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);
  const visible = items.filter(
    (item) => !filter || item.departmentId === filter,
  );
  return (
    <div className="quota-page" aria-busy={loading}>
      <div className="heading">
        <div>
          <h1>พื้นที่จัดเก็บ</h1>
          <p>ตรวจสอบพื้นที่และโควตาของแต่ละหน่วยงาน</p>
        </div>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => void load().catch(() => {})}
        >
          <RefreshCw data-icon="inline-start" aria-hidden="true" />
          {loading ? "กำลังโหลด…" : "รีเฟรชพื้นที่"}
        </Button>
      </div>
      <Alert role="note">
        <Info aria-hidden="true" />
        <AlertTitle>พื้นที่คิดจากไฟล์ทุกเวอร์ชัน</AlertTitle>
        <AlertDescription>
          พื้นที่ใช้แล้วรวมเวอร์ชันย้อนหลังและถังขยะ
          พื้นที่จองรวมงานอัปโหลดและกู้คืนที่ยังไม่เสร็จ ระบบคืนพื้นที่หลัง
          worker ยืนยันการลบแล้ว
        </AlertDescription>
      </Alert>
      {success && (
        <Alert role="status">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>{success}</AlertTitle>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>โหลดพื้นที่ไม่สำเร็จ</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              disabled={loading}
              onClick={() => void load().catch(() => {})}
            >
              ลองใหม่
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="quota-toolbar">
        <Field>
          <FieldLabel htmlFor="quota-department-filter">หน่วยงาน</FieldLabel>
          <select
            id="quota-department-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">หน่วยงานที่ฉันจัดการได้</option>
            {items.map((item) => (
              <option key={item.departmentId} value={item.departmentId}>
                {item.departmentName}
              </option>
            ))}
          </select>
        </Field>
        <p className="quota-updated" role="status">
          {updatedAt
            ? `อัปเดตล่าสุด ${dateFormat.format(updatedAt)} น.`
            : "กำลังเตรียมข้อมูลพื้นที่"}
        </p>
      </div>
      {loading && !items.length ? (
        <div className="quota-loading" role="status">
          <span className="sr-only">กำลังโหลดพื้นที่จัดเก็บ</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : error && !items.length ? null : !visible.length ? (
        <Empty>
          <EmptyHeader>
            <HardDrive aria-hidden="true" />
            <EmptyTitle>ยังไม่มีหน่วยงานที่ดูพื้นที่ได้</EmptyTitle>
            <EmptyDescription>
              ต้องมีสิทธิ์ Editor หรือ Admin ในหน่วยงาน กรุณาติดต่อ
              ผู้ดูแลองค์กร เพื่อขอสิทธิ์
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="quota-legend">
            <span>
              <i className="quota-used" />
              พื้นที่ใช้แล้ว
            </span>
            <span>
              <i className="quota-reserved" />
              พื้นที่จอง
            </span>
          </div>
          <div className="quota-desktop">
            <table className="quota-table">
              <thead>
                <tr>
                  <th>หน่วยงาน / สถานะ</th>
                  <th>ใช้แล้ว</th>
                  <th>จอง</th>
                  <th>เพดาน</th>
                  <th>เหลือ</th>
                  <th>
                    <span className="sr-only">การตั้งค่า</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.departmentId}>
                    <th scope="row">
                      <strong className="quota-name">
                        {item.departmentName}
                      </strong>
                      <Capacity item={item} />
                    </th>
                    <td>
                      <Bytes value={item.usedBytes} />
                    </td>
                    <td>
                      <Bytes value={item.reservedBytes} />
                    </td>
                    <td>
                      {item.limitBytes === null ? (
                        "ไม่จำกัด"
                      ) : (
                        <Bytes value={item.limitBytes} />
                      )}
                    </td>
                    <td>
                      {item.accountingStatus === "ready" &&
                      item.limitBytes === null ? (
                        "ไม่จำกัด"
                      ) : (
                        <Bytes value={item.availableBytes} />
                      )}
                    </td>
                    <td>
                      {item.canManageQuota && (
                        <Button
                          variant="outline"
                          aria-label={`ตั้งโควตา ${item.departmentName}`}
                          onClick={(event) =>
                            openEditor(item, event.currentTarget)
                          }
                        >
                          <Settings2
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          ตั้งโควตา
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="quota-mobile">
            {visible.map((item) => (
              <article key={item.departmentId} className="quota-card">
                <h2>{item.departmentName}</h2>
                <Capacity item={item} />
                <dl>
                  <div>
                    <dt>ใช้แล้ว</dt>
                    <dd>
                      <Bytes value={item.usedBytes} />
                    </dd>
                  </div>
                  <div>
                    <dt>จอง</dt>
                    <dd>
                      <Bytes value={item.reservedBytes} />
                    </dd>
                  </div>
                  <div>
                    <dt>เพดาน</dt>
                    <dd>
                      {item.limitBytes === null ? (
                        "ไม่จำกัด"
                      ) : (
                        <Bytes value={item.limitBytes} />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>เหลือ</dt>
                    <dd>
                      {item.accountingStatus === "ready" &&
                      item.limitBytes === null ? (
                        "ไม่จำกัด"
                      ) : (
                        <Bytes value={item.availableBytes} />
                      )}
                    </dd>
                  </div>
                </dl>
                {item.canManageQuota && (
                  <Button
                    variant="outline"
                    aria-label={`ตั้งโควตา ${item.departmentName}`}
                    onClick={(event) => openEditor(item, event.currentTarget)}
                  >
                    <Settings2 data-icon="inline-start" aria-hidden="true" />
                    ตั้งโควตา
                  </Button>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {selected && (
        <QuotaDialog
          key={selected.departmentId}
          item={selected}
          api={api}
          reload={load}
          onClose={closeEditor}
          onSaved={(item) => {
            setItems((current) =>
              current.map((row) =>
                row.departmentId === item.departmentId ? item : row,
              ),
            );
            closeEditor();
            setSuccess(`บันทึกโควตา ${item.departmentName} แล้ว`);
            void load().catch(() => {});
          }}
        />
      )}
    </div>
  );
}

function QuotaDialog({
  item,
  api,
  reload,
  onClose,
  onSaved,
}: {
  item: StorageQuotaItem;
  api: Api;
  reload: () => Promise<StorageQuotaItem[]>;
  onClose: () => void;
  onSaved: (item: StorageQuotaItem) => void;
}) {
  const [latest, setLatest] = useState(item),
    [unlimited, setUnlimited] = useState(item.limitBytes === null);
  const initialUnit: QuotaUnit =
    item.limitBytes !== null && BigInt(item.limitBytes) >= BigInt(1000000000)
      ? "GB"
      : item.limitBytes !== null && BigInt(item.limitBytes) >= BigInt(1000000)
        ? "MB"
        : "bytes";
  const [unit, setUnit] = useState<QuotaUnit>(initialUnit),
    [amount, setAmount] = useState(
      item.limitBytes === null
        ? ""
        : exactQuotaAmount(item.limitBytes, initialUnit),
    );
  const [touched, setTouched] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(""),
    [needsReload, setNeedsReload] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    summary = useRef<HTMLDivElement>(null);
  let proposed: string | null = null,
    validation = "";
  if (!unlimited) {
    try {
      proposed = parseQuotaAmount(amount, unit);
      if (latest.accountingStatus !== "ready")
        validation = "รอตรวจสอบยอดพื้นที่ก่อนตั้งเพดานแบบจำกัด";
      else if (BigInt(proposed) < BigInt(latest.committedBytes ?? "0"))
        validation = `ต้องตั้งอย่างน้อย ${latest.committedBytes} bytes (${formatQuotaBytes(latest.committedBytes)})`;
    } catch (cause) {
      validation = (cause as Error).message;
    }
  }
  const remaining =
    proposed !== null && !validation && latest.committedBytes !== null
      ? (BigInt(proposed) - BigInt(latest.committedBytes)).toString()
      : null;
  const focusError = () =>
    requestAnimationFrame(() => summary.current?.focus());
  async function reloadLatest() {
    setNeedsReload(true);
    const rows = await reload(),
      row = rows.find((row) => row.departmentId === item.departmentId);
    if (!row?.canManageQuota) throw new Error("permission_changed");
    setLatest(row);
    setNeedsReload(false);
    setConflict(
      "ยอดพื้นที่หรือเพดานเปลี่ยนแล้ว ระบบโหลดค่าล่าสุดให้ กรุณาตรวจสอบค่าที่กรอกและกดบันทึกอีกครั้ง",
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    setError("");
    if (validation) {
      input.current?.focus();
      return;
    }
    if (saving || needsReload) return;
    setSaving(true);
    try {
      const response = await api(
        `/departments/${item.departmentId}/storage-quota`,
        {
          method: "PATCH",
          body: JSON.stringify({
            limitBytes: proposed,
            expectedRevision: latest.revision,
          }),
        },
      );
      onSaved(response.data as StorageQuotaItem);
    } catch (cause) {
      if ((cause as ApiError).code === "quota_revision_conflict") {
        try {
          await reloadLatest();
        } catch {
          setError("โหลดข้อมูลล่าสุดไม่สำเร็จ กรุณาลองโหลดใหม่ก่อนบันทึก");
        }
      } else setError(errorText(cause));
      focusError();
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogShell
      open
      busy={saving}
      title={`ตั้งโควตา ${item.departmentName}`}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <section className="quota-dialog">
        <h2>ตั้งโควตา</h2>
        <p className="quota-name">{item.departmentName}</p>
        <dl className="quota-dialog-summary">
          <div>
            <dt>ใช้แล้ว</dt>
            <dd>
              <Bytes value={latest.usedBytes} />
            </dd>
          </div>
          <div>
            <dt>จอง</dt>
            <dd>
              <Bytes value={latest.reservedBytes} />
            </dd>
          </div>
          <div>
            <dt>ยอดขั้นต่ำที่ตั้งได้</dt>
            <dd>
              {latest.committedBytes === null
                ? "รอตรวจสอบยอด"
                : `${latest.committedBytes} bytes`}
            </dd>
          </div>
        </dl>
        {(error || conflict) && (
          <div ref={summary} tabIndex={-1}>
            <Alert variant={error ? "destructive" : "default"}>
              <AlertCircle aria-hidden="true" />
              <AlertTitle>
                {error ? "ยังบันทึกไม่ได้" : "กรุณาตรวจสอบยอดล่าสุด"}
              </AlertTitle>
              <AlertDescription>{error || conflict}</AlertDescription>
            </Alert>
          </div>
        )}
        {needsReload && (
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void reloadLatest()
                .then(() => setError(""))
                .catch(() => setError("ยังโหลดข้อมูลล่าสุดไม่ได้ กรุณาลองใหม่"))
                .finally(() => setSaving(false));
            }}
          >
            โหลดข้อมูลล่าสุด
          </Button>
        )}
        <form onSubmit={(event) => void submit(event)} noValidate>
          <FieldGroup>
            <FieldSet disabled={saving}>
              <FieldLegend>รูปแบบโควตา</FieldLegend>
              <div className="quota-options">
                <FieldLabel>
                  <input
                    type="radio"
                    name="quota-mode"
                    checked={unlimited}
                    onChange={() => {
                      setUnlimited(true);
                      setTouched(false);
                      setError("");
                    }}
                  />
                  ไม่จำกัด
                </FieldLabel>
                <FieldLabel>
                  <input
                    type="radio"
                    name="quota-mode"
                    checked={!unlimited}
                    disabled={latest.accountingStatus !== "ready"}
                    onChange={() => {
                      setUnlimited(false);
                      setTouched(false);
                      setError("");
                    }}
                  />
                  กำหนดเพดาน
                </FieldLabel>
              </div>
            </FieldSet>
            {!unlimited && (
              <FieldGroup>
                <div className="quota-amount-row">
                  <Field data-invalid={Boolean(touched && validation)}>
                    <FieldLabel htmlFor="quota-amount">จำนวนพื้นที่</FieldLabel>
                    <Input
                      ref={input}
                      id="quota-amount"
                      inputMode="decimal"
                      value={amount}
                      maxLength={40}
                      disabled={saving}
                      aria-invalid={Boolean(touched && validation)}
                      aria-describedby={`quota-unit-help${touched && validation ? " quota-amount-error" : ""}`}
                      onChange={(event) => setAmount(event.target.value)}
                      onBlur={() => setTouched(true)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="quota-unit">หน่วย</FieldLabel>
                    <select
                      id="quota-unit"
                      value={unit}
                      disabled={saving}
                      onChange={(event) => {
                        const next = event.target.value as QuotaUnit;
                        try {
                          setAmount(
                            exactQuotaAmount(
                              parseQuotaAmount(amount, unit),
                              next,
                            ),
                          );
                        } catch {
                          setTouched(true);
                          setError(
                            "กรุณาแก้จำนวนพื้นที่ให้ถูกต้องก่อนเปลี่ยนหน่วย",
                          );
                          return;
                        }
                        setUnit(next);
                      }}
                    >
                      <option value="bytes">bytes</option>
                      <option value="MB">MB</option>
                      <option value="GB">GB</option>
                    </select>
                  </Field>
                </div>
                <FieldDescription id="quota-unit-help">
                  1 MB = 1,000,000 bytes · 1 GB = 1,000,000,000 bytes
                </FieldDescription>
                {touched && validation && (
                  <FieldError id="quota-amount-error" role="alert">
                    {validation}
                  </FieldError>
                )}
              </FieldGroup>
            )}
            <div className="quota-preview" aria-live="polite">
              <strong>หลังบันทึก</strong>
              <p>
                เพดาน:{" "}
                {unlimited
                  ? "ไม่จำกัด"
                  : proposed && !validation
                    ? `${formatQuotaBytes(proposed)} (${proposed} bytes)`
                    : "ตรวจสอบจำนวนพื้นที่"}
              </p>
              <p>
                พื้นที่เหลือ:{" "}
                {unlimited
                  ? "ไม่จำกัด"
                  : validation
                    ? "—"
                    : formatQuotaBytes(remaining)}
              </p>
            </div>
            <div className="dialog-actions">
              <DialogClose asChild>
                <button type="button" className="secondary" disabled={saving}>
                  ยกเลิก
                </button>
              </DialogClose>
              <Button type="submit" disabled={saving || needsReload}>
                {saving ? "กำลังบันทึก…" : "บันทึกโควตา"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </section>
    </DialogShell>
  );
}
