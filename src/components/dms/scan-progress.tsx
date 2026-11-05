"use client";

import { useEffect, useEffectEvent, useState } from "react";

export type ScanReceipt = {
  scanId: string;
  statusUrl: string;
  status: "pending_scan" | "scanning" | "available" | "quarantined" | "scan_failed";
  code?: string;
};
export function scanPending(receipt?: ScanReceipt | null) {
  return receipt?.status === "pending_scan" || receipt?.status === "scanning";
}
const labels = {
  pending_scan: "รอสแกน",
  scanning: "กำลังสแกน",
  available: "พร้อมใช้",
  quarantined: "พบภัย · ไฟล์ถูกกัก",
  scan_failed: "ตรวจไม่ได้ · ไฟล์ยังไม่พร้อมใช้",
};
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const abort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort",abort); resolve(); },ms);
    signal.addEventListener("abort",abort,{once:true});
  });
}

export function ScanProgress({api,receipt,onResult}: {
  api: (path: string, init?: RequestInit)=>Promise<unknown>;
  receipt: ScanReceipt;
  onResult: (result: ScanReceipt)=>void;
}) {
  const [snapshot,setSnapshot] = useState<ScanReceipt|null>(null);
  const [unavailable,setUnavailable] = useState(false);
  const finish = useEffectEvent(onResult);
  const pending = scanPending(receipt);
  const {statusUrl,scanId} = receipt;
  useEffect(() => {
    if (!pending || !/^\/api\/v1\/files\/[\da-f-]{36}\/scan-jobs\/[\da-f-]{36}$/i.test(statusUrl)) return;
    const controller = new AbortController();
    const {signal} = controller;
    async function poll() {
      let delay = 2000;
      while (!signal.aborted) {
        await wait(delay,signal);
        if (signal.aborted) break;
        try {
          const {data} = await api(statusUrl.slice("/api/v1".length),{signal}) as {data:ScanReceipt};
          if (signal.aborted) break;
          if (data.scanId!==scanId || !Object.hasOwn(labels,data.status)) throw new Error("invalid_scan_status");
          setUnavailable(false);
          setSnapshot(data);
          if (!scanPending(data)) { finish(data); break; }
        } catch (error) {
          if (signal.aborted) break;
          setUnavailable(true);
          const response = error as {status?:number; retryAfter?:number};
          if (response.status === 401 || response.status === 403 || response.status === 404) break;
          if (response.retryAfter) delay = Math.max(delay,response.retryAfter*1000);
        }
        delay = Math.max(delay,Math.min(10_000,delay*2));
      }
    }
    void poll();
    return () => controller.abort();
  },[api,pending,statusUrl,scanId]);
  const shown = snapshot?.scanId===scanId ? snapshot : receipt;
  const label = shown.status === "scan_failed" && shown.code === "scan_permission_changed"
    ? "สิทธิ์เปลี่ยนระหว่างสแกน · ไฟล์ยังไม่พร้อมใช้"
    : shown.status === "scan_failed" && shown.code === "version_conflict"
      ? "เวอร์ชันปัจจุบันเปลี่ยน · ไฟล์ยังไม่พร้อมใช้"
      : labels[shown.status];
  return <span role="status">{label}{unavailable && pending ? " · ตรวจสถานะไม่ได้ชั่วคราว" : ""}</span>;
}
