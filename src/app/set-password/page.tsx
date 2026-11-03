"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getBrowserAuth } from "@/lib/browser-auth";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/dms/common";
import {
  NavigationGuardProvider,
  useUnsavedChanges,
} from "@/components/dms/navigation-guard";
export default function SetPasswordPage() {
  return (
    <NavigationGuardProvider>
      <SetPassword />
    </NavigationGuardProvider>
  );
}
function SetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState(""),
    [show, setShow] = useState(false),
    [phase, setPhase] = useState<"checking" | "valid" | "invalid">("checking"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    lock = useRef(false);
  useUnsavedChanges(Boolean(password), busy);
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => getBrowserAuth().auth.getSession())
      .then(({ data: { session } }) => {
        if (active) setPhase(session ? "valid" : "invalid");
      })
      .catch(() => {
        if (active) setPhase("invalid");
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    if (password.length < 12) {
      setMessage("รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
      input.current?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    setMessage("");
    let updated = false;
    try {
      const auth = getBrowserAuth().auth;
      const {
        data: { session },
      } = await auth.getSession();
      if (!session) {
        setPhase("invalid");
        return;
      }
      const { error } = await auth.updateUser({ password });
      if (error) throw error;
      updated = true;
      const response = await fetch("/api/v1/me", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        setMessage(
          "ตั้งรหัสผ่านแล้ว แต่บัญชีนี้ยังเข้าถึงพื้นที่เอกสารนี้ไม่ได้ โปรดติดต่อผู้ดูแล",
        );
        setPassword("");
        return;
      }
      setPassword("");
      router.replace("/");
    } catch {
      setMessage(
        updated
          ? "ตั้งรหัสผ่านแล้ว แต่ตรวจสิทธิ์ไม่สำเร็จ กรุณากลับไปเข้าสู่ระบบหรือติดต่อผู้ดูแล"
          : "ตั้งรหัสผ่านไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองใหม่",
      );
      if (updated) setPassword("");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand">
          <span className="brand-mark">E</span>
          <span>
            EFIN <strong>DMS</strong>
          </span>
        </div>
        <h1>ตั้งรหัสผ่าน</h1>
        {phase === "checking" ? (
          <p role="status">กำลังตรวจสอบคำเชิญ…</p>
        ) : phase === "invalid" ? (
          <>
            <Notice tone="warning">
              ลิงก์คำเชิญนี้ใช้ไม่ได้หรือหมดอายุ
              โปรดติดต่อผู้ดูแลเพื่อขอคำเชิญใหม่
            </Notice>
            <Link className="secondary" href="/">
              กลับไปเข้าสู่ระบบ
            </Link>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <p className="muted">ใช้รหัสผ่านอย่างน้อย 12 ตัวอักษร</p>
            <label htmlFor="new-password">
              รหัสผ่านใหม่
              <Input
                id="new-password"
                ref={input}
                type={show ? "text" : "password"}
                autoComplete="new-password"
                minLength={12}
                required
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(message && password.length < 12)}
                aria-describedby="password-help"
              />
            </label>
            <small id="password-help">สามารถวางจากตัวจัดการรหัสผ่านได้</small>
            <button
              type="button"
              className="quiet"
              aria-pressed={show}
              onClick={() => setShow(!show)}
            >
              {show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
            </button>
            {message && <Notice tone="danger">{message}</Notice>}
            <button className="primary" disabled={busy}>
              {busy ? "กำลังบันทึก…" : "บันทึกรหัสผ่าน"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
