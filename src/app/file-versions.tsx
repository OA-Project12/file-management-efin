"use client";

import { FILE_ACCEPT, browserUploadMime } from "@/domain/files/file-validation";
import { errorText } from "@/components/dms/model";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Eye,
  History,
  RefreshCw,
  RotateCcw,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DialogShell } from "@/components/ui/dialog-shell";
import { ScanProgress, scanPending, type ScanReceipt } from "@/components/dms/scan-progress";
import { SignedPreview } from "@/components/dms/preview";

type Version = {
  id: string;
  versionNumber: number;
  originalName: string;
  contentType: string;
  sizeBytes: string;
  status: string;
  createdByKind: string;
  createdById: string | null;
  createdAt: string;
  restoredFromVersionId: string | null;
};
type Page = {
  currentVersionId: string | null;
  items: Version[];
  nextCursor: string | null;
};
type Props = {
  enabled?: boolean;
  fileId: string;
  fileName: string;
  canEdit: boolean;
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  onCurrentChanged: (version?: {
    originalName: string;
    contentType: string;
    sizeBytes: string;
  }) => void;
  onBusyChange: (busy: boolean) => void;
};
const date = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  dateStyle: "medium",
  timeStyle: "short",
});
const size = (value: string | number) =>
  Number(value) < 1024
    ? `${value} B`
    : Number(value) < 1048576
      ? `${(Number(value) / 1024).toFixed(1)} KB`
      : `${(Number(value) / 1048576).toFixed(1)} MB`;
const statusLabel: Record<string, string> = {
  available: "พร้อมใช้งาน",
  pending_upload: "รอยืนยัน",
  pending_scan: "รอสแกน",
  failed: "ไม่สำเร็จ",
  quarantined: "ถูกระงับ",
};
const codeOf = (error: unknown) => (error as { code?: string })?.code;
function message(error: unknown) {
  if (["file_type_not_allowed", "file_signature_invalid", "file_type_mismatch", "file_validation_unavailable"].includes(codeOf(error) ?? "")) return errorText(error);
  const labels: Record<string, string> = {
    department_quota_exceeded:
      "พื้นที่ของหน่วยงานไม่พอ กรุณาติดต่อผู้ดูแลหรือรอให้การลบถาวรเสร็จ",
    upload_size_exceeds_reservation:
      "ขนาดไฟล์จริงเกินพื้นที่ที่จองไว้ กรุณาเลือกไฟล์และเริ่มอัปโหลดใหม่",
    version_conflict:
      "มีการเปลี่ยนเวอร์ชันปัจจุบัน กรุณาโหลดรายการล่าสุดและตรวจสอบก่อนทำอีกครั้ง",
    version_already_current: "ฉบับที่เลือกเป็นเวอร์ชันปัจจุบันแล้ว",
    unauthorized: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง",
    forbidden: "คุณไม่มีสิทธิ์ดำเนินการนี้",
    file_not_found: "ไม่พบไฟล์หรือสิทธิ์เข้าถึงมีการเปลี่ยนแปลง",
    version_not_found: "ไม่พบเวอร์ชันที่พร้อมใช้งาน",
    object_not_found:
      "ยังไม่พบข้อมูลไฟล์ใน Storage กรุณาตรวจสอบรายการก่อนเริ่มอัปโหลดใหม่",
    object_changed: "ข้อมูลไฟล์ไม่ตรงกับเวอร์ชัน กรุณาติดต่อผู้ดูแล",
    file_too_large: "ไฟล์เกินขนาดที่ระบบอนุญาต",
    upload_intent_expired: "สิทธิ์อัปโหลดหมดอายุ กรุณาเริ่มอัปโหลดใหม่",
    preview_not_supported: "ไฟล์ชนิดนี้ดูตัวอย่างไม่ได้ กรุณาดาวน์โหลดแทน",
    audit_unavailable: "บันทึกประวัติไม่สำเร็จ กรุณาลองอีกครั้ง",
    restore_expired: "การกู้คืนหมดเวลา กรุณาตรวจรายการก่อนลองอีกครั้ง",
  };
  return (
    labels[codeOf(error) ?? ""] ??
    (error instanceof Error ? error.message : "เกิดข้อผิดพลาด กรุณาลองอีกครั้ง")
  );
}

export function FileVersions(props: Props) {
  return useFileVersionsView(props);
}

// Keep the operation state at the details owner so a dock/sheet resize cannot abort an upload.
export function useFileVersionsView({
  enabled = true,
  fileId,
  fileName,
  canEdit,
  api,
  onCurrentChanged,
  onBusyChange,
}: Props) {
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [receipt,setScan] = useState<ScanReceipt|null>(null);
  const scan = enabled && receipt?.statusUrl.startsWith(`/api/v1/files/${fileId}/scan-jobs/`) ? receipt : null;
  const [operation, setOperation] = useState<string | null>(null);
  const [target, setTarget] = useState<Version | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState("");
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    type: string;
    name: string;
    number: number;
  } | null>(null);
  const [link, setLink] = useState<{ url: string; name: string } | null>(null);
  const mounted = useRef(true);
  const serial = useRef(0);
  const lock = useRef(false);
  const xhr = useRef<XMLHttpRequest | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const busy = operation !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      xhr.current?.abort();
    };
  }, []);
  useEffect(() => {
    onBusyChange(operation === "upload" || operation === "restore");
    return () => onBusyChange(false);
  }, [operation, onBusyChange]);
  useEffect(() => {
    if (feedback) feedbackRef.current?.focus();
  }, [feedback]);

  const load = useCallback(
    async (cursor: string | null = null) => {
      const request = ++serial.current;
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ limit: "25" });
        if (cursor) query.set("cursor", cursor);
        const data = (
          (await api(`/files/${fileId}/versions?${query}`)) as { data: Page }
        ).data;
        if (mounted.current && request === serial.current) {
          setDenied(false);
          setPage((old) =>
            cursor && old
              ? {
                  ...data,
                  items: [
                    ...old.items,
                    ...data.items.filter(
                      (v) => !old.items.some((o) => o.id === v.id),
                    ),
                  ],
                }
              : data,
          );
        }
        return data;
      } catch (e) {
        if (mounted.current && request === serial.current) {
          setError(message(e));
          if (
            ["unauthorized", "forbidden", "file_not_found"].includes(
              codeOf(e) ?? "",
            )
          ) {
            setDenied(true);
            setPage(null);
          }
        }
        return null;
      } finally {
        if (mounted.current && request === serial.current) setLoading(false);
      }
    },
    [api, fileId],
  );
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    api(`/files/${fileId}/versions?limit=25`)
      .then((result) => {
        if (active) setPage((result as { data: Page }).data);
      })
      .catch((e) => {
        if (active) {
          setError(message(e));
          setDenied(
            ["unauthorized", "forbidden", "file_not_found"].includes(
              codeOf(e) ?? "",
            ),
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, fileId, enabled]);

  function start(name: string) {
    if (lock.current) return false;
    lock.current = true;
    setOperation(name);
    setError("");
    setFeedback("");
    setLink(null);
    return true;
  }
  function end() {
    lock.current = false;
    if (mounted.current) setOperation(null);
  }
  async function changed(success: string) {
    if (!mounted.current) return;
    const latest = await load();
    if (!mounted.current) return;
    const current = latest?.items.find((v) => v.id === latest.currentVersionId);
    onCurrentChanged(
      current
        ? {
            originalName: current.originalName,
            contentType: current.contentType,
            sizeBytes: current.sizeBytes,
          }
        : undefined,
    );
    setFeedback(success);
  }
  async function grant(version: Version, kind: "preview" | "download") {
    if (!start(`${kind}:${version.id}`)) return;
    try {
      const result = (
        (await api(`/files/${fileId}/versions/${version.id}/${kind}-url`, {
          method: "POST",
          body: "{}",
        })) as {
          data: { signedUrl: string; contentType: string; fileName: string };
        }
      ).data;
      if (!mounted.current) return;
      if (kind === "preview")
        setPreview({
          url: result.signedUrl,
          type: result.contentType,
          name: result.fileName,
          number: version.versionNumber,
        });
      else setLink({ url: result.signedUrl, name: result.fileName });
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      end();
    }
  }
  async function restore() {
    if (!target || !page?.currentVersionId || scanPending(scan) || !start("restore")) return;
    setRestoreError("");
    try {
      const result = (
        (await api(`/files/${fileId}/versions/${target.id}/restore`, {
          method: "POST",
          body: JSON.stringify({
            expectedCurrentVersionId: page.currentVersionId,
          }),
        })) as { data: ScanReceipt & { versionNumber: number } }
      ).data;
      if (!mounted.current) return;
      setTarget(null);
      if (result.scanId) { setScan(result); await load(); return; }
      await changed(
        `กู้คืนแล้ว · สร้างเวอร์ชัน ${result.versionNumber} จากเวอร์ชัน ${target.versionNumber}`,
      );
    } catch (e) {
      if (!mounted.current) return;
      setRestoreError(message(e));
      // Do not silently replace the user's expected current version inside an open confirmation.
      if (codeOf(e) === "version_conflict") {
        setTarget(null);
        await load();
        setError(message(e));
      } else
        setRestoreError(
          `${message(e)} · หากไม่ได้รับผลยืนยัน ให้ปิดหน้าต่างแล้วโหลดรายการเพื่อตรวจผลก่อนลองอีกครั้ง`,
        );
    } finally {
      end();
    }
  }

  async function upload(retry = false) {
    if (!file || !page?.currentVersionId || scanPending(scan) || !start("upload")) return;
    try {
      const uploadMime = browserUploadMime(file);
      let id = retry ? resumeId : null;
      if (!id) {
        setUploadStage("กำลังเตรียมอัปโหลด");
        setProgress(0);
        const intent = (
          (await api(`/files/${fileId}/versions/upload-intents`, {
            method: "POST",
            body: JSON.stringify({
              expectedCurrentVersionId: page.currentVersionId,
              originalName: file.name,
              contentType: uploadMime,
              sizeBytes: file.size,
            }),
          })) as { data: { versionId: string; signedUrl: string } }
        ).data;
        id = intent.versionId;
        if (!mounted.current) return;
        setResumeId(id);
        setUploadStage("กำลังส่งไฟล์");
        await new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest();
          xhr.current = request;
          request.open("PUT", intent.signedUrl);
          request.setRequestHeader(
            "Content-Type",
            uploadMime,
          );
          request.timeout = 120000;
          request.upload.onprogress = (e) => {
            if (mounted.current && e.lengthComputable)
              setProgress(Math.round((e.loaded / e.total) * 100));
          };
          request.onload = () =>
            request.status >= 200 && request.status < 300
              ? resolve()
              : reject(new Error(`ส่งไฟล์ไม่สำเร็จ (${request.status})`));
          request.onerror =
            request.ontimeout =
            request.onabort =
              () =>
                reject(
                  new Error(
                    "การส่งไฟล์ขาดการเชื่อมต่อ กรุณาตรวจสอบผลก่อนเริ่มใหม่",
                  ),
                );
          request.send(file);
        });
      }
      if (!mounted.current) return;
      setUploadStage("กำลังตรวจประเภทไฟล์และยืนยัน");
      const completed = await api(`/files/${fileId}/versions/${id}/complete`, {
        method: "POST",
        body: "{}",
      });
      if (!mounted.current) return;
      setResumeId(null);
      setFile(null);
      setUploadStage("");
      setProgress(0);
      if (fileInput.current) fileInput.current.value = "";
      const receipt = (completed as {data:ScanReceipt}).data;
      if (receipt.scanId) { setScan(receipt); await load(); return; }
      await changed("บันทึกเวอร์ชันใหม่แล้ว");
    } catch (e) {
      if (mounted.current) {
        setError(message(e));
        setUploadStage("");
        if (
          [
            "version_conflict",
            "upload_intent_expired",
            "object_not_found",
            "file_too_large",
            "file_type_not_allowed",
            "file_signature_invalid",
            "file_type_mismatch",
            "upload_not_pending",
            "department_quota_exceeded",
            "upload_size_exceeds_reservation",
          ].includes(codeOf(e) ?? "")
        )
          setResumeId(null);
        await load();
        setError(message(e));
      }
    } finally {
      xhr.current = null;
      end();
    }
  }

  return (
    <section className="file-versions" aria-label="ประวัติเวอร์ชัน">
      {scan && <ScanProgress key={scan.scanId} api={api} receipt={scan} onResult={(result)=>{
        setScan(result);
        if (result.status==="available") void changed("เวอร์ชันผ่านการสแกนและพร้อมใช้งานแล้ว");
        else void load();
      }} />}
      <div className="version-heading">
        <div>
          <h3>
            <History aria-hidden="true" />
            ประวัติเวอร์ชัน
          </h3>
          <p>แต่ละฉบับเก็บเนื้อหาแยกกัน</p>
        </div>
        <Button
          variant="ghost"
          className="version-icon-button"
          aria-label="โหลดประวัติเวอร์ชันใหม่"
          disabled={busy || loading}
          onClick={() => void load()}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </div>
      {feedback && (
        <p
          ref={feedbackRef}
          tabIndex={-1}
          className="version-success"
          role="status"
        >
          {feedback}
        </p>
      )}
      {operation?.startsWith("preview:") && (
        <p role="status">กำลังเตรียมตัวอย่าง…</p>
      )}
      {operation?.startsWith("download:") && (
        <p role="status">กำลังเตรียมลิงก์ดาวน์โหลด…</p>
      )}
      {error && (
        <div className="version-error" role="alert">
          <p>{error}</p>
          <Button
            variant="outline"
            disabled={busy || loading}
            onClick={() => void load()}
          >
            โหลดรายการใหม่
          </Button>
        </div>
      )}
      {canEdit && !denied && (
        <fieldset
          className="version-upload"
          disabled={busy || scanPending(scan) || loading || !page?.currentVersionId}
        >
          <legend>อัปโหลดเวอร์ชันใหม่</legend>
          <p>
            เพิ่มฉบับแก้ไขให้เอกสารนี้
            ชื่อแสดงผลและตำแหน่งโฟลเดอร์ยังใช้ค่าปัจจุบัน · รับ PDF, JPG/JPEG และ PNG
          </p>
          <label htmlFor={`version-file-${fileId}`}>เลือกไฟล์ฉบับแก้ไข</label>
          <input
            ref={fileInput}
            id={`version-file-${fileId}`}
            type="file"
            accept={FILE_ACCEPT}
            disabled={busy || Boolean(resumeId)}
            onChange={(e) => {
              const picked = e.target.files?.[0] ?? null;
              setFile(picked);
              setError(
                picked?.size === 0 ? "ไฟล์ว่าง กรุณาเลือกไฟล์ที่มีข้อมูล" : "",
              );
            }}
          />
          {file && (
            <p className="version-picked">
              {file.name} · {size(file.size)}
            </p>
          )}
          {operation === "upload" && (
            <div role="status">
              <p>
                {uploadStage}
                {uploadStage === "กำลังส่งไฟล์" ? ` ${progress}%` : "…"}
              </p>
              <progress
                value={progress}
                max={100}
                aria-label="ความคืบหน้าการส่งไฟล์"
              />
            </div>
          )}
          {resumeId && !busy && (
            <p>
              มีคำขออัปโหลดที่ยังไม่ได้รับผลยืนยัน ตรวจสอบคำขอเดิมก่อนเริ่มใหม่
            </p>
          )}
          <Button
            disabled={
              busy ||
              !file ||
              file.size === 0 ||
              loading ||
              !page?.currentVersionId
            }
            onClick={() => void upload(Boolean(resumeId))}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />
            {resumeId ? "ตรวจสอบและยืนยันอีกครั้ง" : "อัปโหลดฉบับใหม่"}
          </Button>
        </fieldset>
      )}
      {!canEdit && (
        <p className="version-help">
          คุณดูตัวอย่างและดาวน์โหลดฉบับที่พร้อมใช้งานได้
        </p>
      )}
      {loading && !page && <p role="status">กำลังโหลดประวัติเวอร์ชัน…</p>}
      {page && page.items.length === 0 && (
        <p className="version-empty">ยังไม่มีเวอร์ชันที่บันทึกไว้</p>
      )}
      <ol
        className="version-list"
        aria-label="รายการเวอร์ชัน"
        aria-busy={loading}
      >
        {page?.items.map((v) => (
          <li
            key={v.id}
            className={v.id === page.currentVersionId ? "version-current" : ""}
          >
            <div className="version-row-title">
              <strong>เวอร์ชัน {v.versionNumber}</strong>
              <Badge
                variant={v.id === page.currentVersionId ? "default" : "outline"}
              >
                {v.id === page.currentVersionId
                  ? "ปัจจุบัน"
                  : (statusLabel[v.status] ?? v.status)}
              </Badge>
            </div>
            <p className="version-name">{v.originalName}</p>
            <p>
              {size(v.sizeBytes)} · {date.format(new Date(v.createdAt))}
            </p>
            <p className="version-actor">
              {v.createdByKind === "migration"
                ? "นำเข้าจากไฟล์เดิม"
                : v.createdByKind === "api_key"
                  ? "อัปโหลดผ่าน API key"
                  : "ผู้ใช้"}
              {v.createdById && (
                <span title={v.createdById}> · {v.createdById}</span>
              )}
            </p>
            {v.restoredFromVersionId && (
              <p>
                สร้างจากเวอร์ชันที่กู้คืน
                {page.items.find((s) => s.id === v.restoredFromVersionId)
                  ? ` (เวอร์ชัน ${page.items.find((s) => s.id === v.restoredFromVersionId)?.versionNumber})`
                  : ""}
              </p>
            )}
            {v.status === "available" && (
              <div className="version-row-actions">
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-label={`ดูตัวอย่างเวอร์ชัน ${v.versionNumber}`}
                  onClick={() => void grant(v, "preview")}
                >
                  <Eye data-icon="inline-start" aria-hidden="true" />
                  ดูตัวอย่าง
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-label={`ดาวน์โหลดเวอร์ชัน ${v.versionNumber}`}
                  onClick={() => void grant(v, "download")}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />
                  ดาวน์โหลด
                </Button>
                {canEdit && v.id !== page.currentVersionId && (
                  <Button
                    variant="ghost"
                    disabled={busy || loading}
                    aria-label={`กู้คืนเวอร์ชัน ${v.versionNumber}`}
                    onClick={() => {
                      setTarget(v);
                      setRestoreError("");
                    }}
                  >
                    <RotateCcw data-icon="inline-start" aria-hidden="true" />
                    กู้คืนฉบับนี้
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {link && (
        <p className="version-download" role="status">
          ลิงก์พร้อมใช้งาน 5 นาที{" "}
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            ดาวน์โหลด {link.name}
          </a>
        </p>
      )}
      {page?.nextCursor && (
        <Button
          variant="outline"
          disabled={busy || loading}
          onClick={() => void load(page.nextCursor)}
        >
          {loading ? "กำลังโหลด…" : "โหลดเวอร์ชันเพิ่ม"}
        </Button>
      )}
      {target && (
        <DialogShell
          open
          title={`กู้คืนเวอร์ชัน ${target.versionNumber}`}
          busy={busy}
          dirty={false}
          size="confirm"
          onOpenChange={(open) => {
            if (!open && !busy) setTarget(null);
          }}
        >
          <section className="action-dialog">
            <h2>กู้คืนเวอร์ชัน {target.versionNumber}?</h2>
            <p className="version-name">{fileName}</p>
            <p>
              ระบบจะสร้างเวอร์ชันใหม่จากฉบับนี้แล้วใช้เป็นฉบับปัจจุบัน
              ใช้พื้นที่เพิ่ม และเก็บประวัติเดิมและสิทธิ์เข้าถึงเอกสารไว้
            </p>
            <p>
              ต้นฉบับ: {target.originalName} ·{" "}
              {date.format(new Date(target.createdAt))}
            </p>
            {restoreError && (
              <p className="field-error" role="alert">
                {restoreError}
              </p>
            )}
            <div className="dialog-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setTarget(null)}
              >
                ยกเลิก
              </Button>
              <Button disabled={busy} onClick={() => void restore()}>
                {operation === "restore"
                  ? "กำลังคัดลอกและกู้คืน…"
                  : "ยืนยันกู้คืน"}
              </Button>
            </div>
          </section>
        </DialogShell>
      )}
      {preview && (
        <DialogShell
          open
          title={`ดูตัวอย่างเวอร์ชัน ${preview.number}`}
          dirty={false}
          size="wide"
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
        >
          <section className="version-preview-dialog">
            <div>
              <h2>เวอร์ชัน {preview.number}</h2>
              <Button variant="outline" onClick={() => setPreview(null)}>
                ปิดตัวอย่าง
              </Button>
            </div>
            <p className="version-name">{preview.name}</p>
            <p>ลิงก์มีอายุ 5 นาที หากหมดอายุให้ปิดแล้วขอดูตัวอย่างใหม่</p>
            <SignedPreview
              key={preview.url}
              grant={{
                signedUrl: preview.url,
                contentType: preview.type,
                expiresInSeconds: 300,
              }}
              title={preview.name}
              onRenew={() => {
                const version = page?.items.find(
                  (v) => v.versionNumber === preview.number,
                );
                if (version) void grant(version, "preview");
              }}
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const version = page?.items.find(
                  (v) => v.versionNumber === preview.number,
                );
                if (version) void grant(version, "download");
              }}
            >
              ดาวน์โหลดฉบับนี้
            </Button>
          </section>
        </DialogShell>
      )}
    </section>
  );
}
