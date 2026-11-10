"use client";
import { FILE_ACCEPT, browserUploadMime } from "@/domain/files/file-validation";
import { useRef, useState } from "react";
import { CheckCircle2, FileText, Upload } from "lucide-react";
import { DialogClose, DialogShell } from "@/components/ui/dialog-shell";
import type { Api, Department, FileRow, Scope } from "./model";
import { errorText, fileSize } from "./model";
import { Notice } from "./common";

import { ScanProgress, type ScanReceipt } from "./scan-progress";

type Result = {
    file: File;
    fileId?: string;
    sizeBytes?: string;
    scan?: ScanReceipt;
    status: "waiting" | "preparing" | "sending" | "confirming" | "pending_scan" | "completed" | "partial" | "error" | "unknown";
    message?: string;
    retryable?: boolean;
};
type Intent = {
    index: number;
    status: "ready" | "error";
    fileId?: string;
    signedUrl?: string;
    error?: { code?: string };
};
const labels: Record<Result["status"], string> = {
    waiting: "รอดำเนินการ",
    preparing: "กำลังเตรียมอัปโหลด",
    sending: "กำลังอัปโหลด",
    confirming: "ส่งไฟล์แล้ว กำลังตรวจสอบและยืนยัน",
    pending_scan: "รอสแกน",
    completed: "สำเร็จ",
    partial: "ยืนยันไฟล์แล้ว แต่ย้ายเข้าโฟลเดอร์ไม่สำเร็จ",
    error: "ไม่สำเร็จ",
    unknown: "ยังยืนยันผลไม่ได้ โปรดตรวจรายการก่อนอัปโหลดใหม่",
};
export function UploadQueue({
    api,
    scope,
    department,
    onClose,
    onRefresh,
    onFile,
    onDepartment,
}: {
    api: Api;
    scope: Scope;
    department: Department;
    onClose: () => void;
    onRefresh: () => void;
    onFile: (file: FileRow) => void;
    onDepartment: () => void;
}) {
    const [results, setResults] = useState<Result[]>([]),
        [busy, setBusy] = useState(false);
    const lock = useRef(false);
    const destination = [department.name, ...scope.path.map((f) => f.name)].join(" / ");
    async function run(files: File[], retry = false) {
        if (lock.current || (!retry && !files.length)) return;
        lock.current = true;
        setBusy(true);
        const rows: Result[] = retry
            ? results.map((row) =>
                  row.retryable
                      ? {
                            ...row,
                            status: "waiting",
                            retryable: false,
                            message: undefined,
                        }
                      : row,
              )
            : files.map((file) => {
                  try {
                      browserUploadMime(file);
                      return { file, status: "waiting" };
                  } catch (error) {
                      return { file, status: "error", message: errorText(error), retryable: false };
                  }
              });
        const indexes = rows.map((row, index) => (row.status === "waiting" ? index : -1)).filter((index) => index >= 0);
        setResults([...rows]);
        const update = (index: number, change: Partial<Result>) => {
            rows[index] = { ...rows[index], ...change };
            setResults([...rows]);
        };
        try {
            for (let start = 0; start < indexes.length; start += 20) {
                const chunk = indexes.slice(start, start + 20);
                chunk.forEach((index) => update(index, { status: "preparing" }));
                let intents: Intent[];
                try {
                    intents = (
                        await api<{ items: Intent[] }>("/files/upload-intents/batch", {
                            method: "POST",
                            body: JSON.stringify({
                                departmentId: scope.departmentId,
                                folderId: scope.folderId || null,
                                files: chunk.map((index) => ({
                                    originalName: rows[index].file.name,
                                    contentType: browserUploadMime(rows[index].file),
                                    sizeBytes: rows[index].file.size,
                                })),
                            }),
                        })
                    ).data.items;
                } catch (cause) {
                    chunk.forEach((index) =>
                        update(index, {
                            status: "error",
                            message: errorText(cause),
                            retryable: true,
                        }),
                    );
                    continue;
                }
                const ready = chunk.flatMap((index, position) => {
                    const intent = intents.find((item) => item.index === position);
                    if (!intent || intent.status === "error" || !intent.fileId || !intent.signedUrl) {
                        update(index, {
                            status: "error",
                            message: intent?.error ? errorText(intent.error) : "คำขอไม่สมบูรณ์ กรุณาตรวจรายการ",
                            retryable: !["file_type_not_allowed", "file_type_mismatch"].includes(intent?.error?.code ?? ""),
                        });
                        return [];
                    }
                    return [{ index, intent }];
                });
                for (let offset = 0; offset < ready.length; offset += 3)
                    await Promise.all(
                        ready.slice(offset, offset + 3).map(async ({ index, intent }) => {
                            const file = rows[index].file;
                            update(index, { status: "sending", fileId: intent.fileId });
                            try {
                                const response = await fetch(intent.signedUrl!, {
                                    method: "PUT",
                                    headers: {
                                        "Content-Type": browserUploadMime(file),
                                    },
                                    body: file,
                                });
                                if (!response.ok) throw new Error("storage_send_failed");
                                update(index, { status: "confirming" });
                                const completed = await api<ScanReceipt & { sizeBytes?: number | string }>(
                                    `/files/${intent.fileId}/complete`,
                                    { method: "POST" },
                                );
                                update(index, {
                                    sizeBytes: String(completed.data.sizeBytes ?? file.size),
                                });
                                if (completed.data.scanId) {
                                    const status =
                                        completed.data.status === "available"
                                            ? "completed"
                                            : ["pending_scan", "scanning"].includes(completed.data.status)
                                              ? "pending_scan"
                                              : "error";
                                    update(index, { status, scan: completed.data });
                                    return;
                                }
                                if (scope.folderId) {
                                    try {
                                        await api(`/files/${intent.fileId}/metadata`, {
                                            method: "PATCH",
                                            body: JSON.stringify({ folderId: scope.folderId }),
                                        });
                                    } catch (cause) {
                                        update(index, {
                                            status: "partial",
                                            message: errorText(cause),
                                        });
                                        return;
                                    }
                                }
                                update(index, { status: "completed" });
                            } catch (cause) {
                                update(index, {
                                    status: ["file_type_not_allowed", "file_signature_invalid", "file_type_mismatch"].includes(
                                        (cause as { code?: string })?.code ?? "",
                                    )
                                        ? "error"
                                        : "unknown",
                                    message: errorText(cause),
                                    retryable: false,
                                });
                            }
                        }),
                    );
            }
        } finally {
            lock.current = false;
            setBusy(false);
            onRefresh();
        }
    }
    const counts = {
        completed: results.filter((r) => r.status === "completed").length,
        pending: results.filter((r) => r.status === "pending_scan").length,
        partial: results.filter((r) => r.status === "partial").length,
        failed: results.filter((r) => r.status === "error" || r.status === "unknown").length,
    };
    return (
        <DialogShell
            open
            title="อัปโหลดไฟล์"
            size="wide"
            busy={busy}
            dirty={false}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <section
                className="upload-queue"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                    e.preventDefault();
                    if (!busy) void run(Array.from(e.dataTransfer.files));
                }}
            >
                <h2>อัปโหลดไฟล์</h2>
                <p>
                    ปลายทาง: <strong>{destination}</strong>
                </p>
                <p className="muted">รับ PDF, JPG/JPEG และ PNG · เมื่อขึ้นสถานะรอสแกน คุณปิดหน้าต่างได้ ระบบจะตรวจไฟล์ต่อเบื้องหลัง</p>
                <label className="file-picker">
                    <Upload aria-hidden="true" />
                    <span>เลือกไฟล์เพื่ออัปโหลด</span>
                    <input
                        aria-label="เลือกไฟล์เพื่ออัปโหลด"
                        type="file"
                        accept={FILE_ACCEPT}
                        multiple
                        disabled={busy}
                        onChange={(event) => {
                            const files = Array.from(event.target.files ?? []);
                            event.target.value = "";
                            void run(files);
                        }}
                    />
                </label>
                {busy && <Notice>กำลังอัปโหลด กรุณารอให้เสร็จก่อนปิดหรือเปลี่ยนตำแหน่ง</Notice>}
                {results.length > 0 && (
                    <>
                        <p className="upload-summary" role="status" aria-live="polite">
                            สำเร็จ {counts.completed} · รอผลสแกน {counts.pending} · สำเร็จบางส่วน {counts.partial} ·
                            ไม่สำเร็จ/ยังยืนยันผลไม่ได้ {counts.failed} จาก {results.length} ไฟล์
                        </p>
                        <ol className="upload-results">
                            {results.map((row, index) => (
                                <li key={index}>
                                    <FileText aria-hidden="true" />
                                    <div>
                                        <strong className="full-name">{row.file.name}</strong>
                                        <small>{fileSize(row.file.size)}</small>
                                        <p className={`result-${row.status}`}>
                                            {row.status === "completed" && <CheckCircle2 aria-hidden="true" />}
                                            {row.scan ? (
                                                <ScanProgress
                                                    api={api}
                                                    receipt={row.scan}
                                                    onResult={(scan) => {
                                                        setResults((previous) =>
                                                            previous.map((item) =>
                                                                item.scan?.scanId === scan.scanId
                                                                    ? {
                                                                          ...item,
                                                                          scan,
                                                                          status: scan.status === "available" ? "completed" : "error",
                                                                      }
                                                                    : item,
                                                            ),
                                                        );
                                                        if (scan.status === "available") onRefresh();
                                                    }}
                                                />
                                            ) : (
                                                labels[row.status]
                                            )}
                                        </p>
                                        {row.message && <p>{row.message}</p>}
                                        {row.status === "completed" && (
                                            <button
                                                className="secondary"
                                                disabled={busy}
                                                onClick={() => {
                                                    onClose();
                                                    onFile({
                                                        id: row.fileId!,
                                                        departmentId: scope.departmentId,
                                                        folderId: scope.folderId || null,
                                                        originalName: row.file.name,
                                                        contentType: browserUploadMime(row.file),
                                                        sizeBytes: row.sizeBytes ?? String(row.file.size),
                                                    });
                                                }}
                                            >
                                                เปิดเอกสาร
                                            </button>
                                        )}
                                        {(row.status === "partial" || row.status === "unknown") && (
                                            <button
                                                className="secondary"
                                                disabled={busy}
                                                onClick={() => {
                                                    onClose();
                                                    onDepartment();
                                                }}
                                            >
                                                ตรวจไฟล์ในหน่วยงาน
                                            </button>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ol>
                        {results.some((row) => row.retryable) && (
                            <button className="secondary" disabled={busy} onClick={() => void run([], true)}>
                                ลองไฟล์ที่ยังไม่เริ่มอัปโหลดอีกครั้ง
                            </button>
                        )}
                    </>
                )}
                <div className="dialog-actions">
                    <DialogClose asChild>
                        <button className="secondary" disabled={busy}>
                            ปิดผลการอัปโหลด
                        </button>
                    </DialogClose>
                </div>
            </section>
        </DialogShell>
    );
}
