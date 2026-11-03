"use client";
import { useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, FileText, Info, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DialogShell } from "@/components/ui/dialog-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";

export function Notice({
  children,
  tone = "info",
  onClose,
}: {
  children: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  onClose?: () => void;
}) {
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "danger" || tone === "warning"
        ? AlertCircle
        : Info;
  return (
    <Alert
      className={`inline-alert alert-${tone}`}
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon aria-hidden="true" />
      <AlertDescription className="notice-copy">{children}</AlertDescription>
      {onClose && (
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="ปิดข้อความแจ้งเตือน"
        >
          <X aria-hidden="true" />
        </button>
      )}
    </Alert>
  );
}
export function StatePanel({
  title,
  children,
  action,
  error,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  error?: boolean;
}) {
  if (!error)
    return (
      <Empty className="state-panel">
        <EmptyHeader>
          <FileText aria-hidden="true" />
          <EmptyTitle>
            <h2>{title}</h2>
          </EmptyTitle>
          {children && <EmptyDescription>{children}</EmptyDescription>}
        </EmptyHeader>
        {action}
      </Empty>
    );
  return (
    <div
      className={`state-panel${error ? " error-state" : ""}`}
      role={error ? "alert" : undefined}
    >
      <FileText aria-hidden="true" />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function LoadingRows({
  label = "กำลังโหลดเอกสาร…",
}: {
  label?: string;
}) {
  return (
    <div className="loading-rows" role="status">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
export function FullName({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="name-disclosure"
        aria-label={`แสดงชื่อเต็ม ${name}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        ชื่อเต็ม
      </button>
      {open && (
        <DialogShell
          open
          title="ชื่อเอกสารเต็ม"
          size="confirm"
          dirty={false}
          onOpenChange={setOpen}
        >
          <h2>ชื่อเอกสารเต็ม</h2>
          <p className="full-name">{name}</p>
          <button className="secondary" onClick={() => setOpen(false)}>
            ปิด
          </button>
        </DialogShell>
      )}
    </>
  );
}
export function CopyButton({
  value,
  label = "คัดลอก ID",
}: {
  value: string;
  label?: string;
}) {
  const [result, setResult] = useState("");
  return (
    <span className="copy-control">
      <button
        className="secondary"
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => setResult("คัดลอกแล้ว"))
            .catch(() =>
              setResult("คัดลอกไม่สำเร็จ กรุณาเลือกข้อความและคัดลอกด้วยตนเอง"),
            )
        }
      >
        {label}
      </button>
      <span role="status">{result}</span>
    </span>
  );
}
