"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "./common";

export function AuthScreen({
  checking,
  onLogin,
  error,
  onSignOut,
}: {
  checking?: boolean;
  onLogin?: (email: string, password: string) => Promise<void>;
  error?: string;
  onSignOut?: () => void;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [show, setShow] = useState(false),
    [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onLogin?.(email.trim(), password);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link className="brand" href="/" aria-label="EFIN DMS หน้าเข้าสู่ระบบ">
          <span className="brand-mark">E</span>
          <span>
            EFIN <strong>DMS</strong>
          </span>
        </Link>
        <h1>
          {checking
            ? "กำลังตรวจสอบการเข้าสู่ระบบ"
            : "เข้าสู่พื้นที่เอกสารขององค์กร"}
        </h1>
        <p className="muted">ใช้บัญชีที่ผู้ดูแลเชิญเพื่อเข้าถึงเอกสารของคุณ</p>
        {checking ? (
          <p role="status">กำลังตรวจสอบ session และสิทธิ์เข้าถึง…</p>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="login-email">อีเมล</label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={busy}
            />
            <label htmlFor="login-password">รหัสผ่าน</label>
            <div className="password-control">
              <Input
                id="login-password"
                type={show ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={busy}
              />
              <button
                type="button"
                className="quiet"
                aria-pressed={show}
                onClick={() => setShow(!show)}
              >
                {show ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
              </button>
            </div>
            {error && <Notice tone="danger">{error}</Notice>}
            <Button type="submit" className="auth-submit" disabled={busy}>
              {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
            </Button>
            <Link className="quiet" href="/forgot-password">
              ลืมรหัสผ่าน?
            </Link>
            {onSignOut && (
              <button className="secondary" type="button" onClick={onSignOut}>
                ออกจากระบบบัญชีนี้
              </button>
            )}
          </form>
        )}
        <p className="auth-footer">EFIN Document Management System</p>
      </section>
    </main>
  );
}
