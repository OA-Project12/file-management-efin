"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/dms/common";
import { RecoveryCard } from "@/components/dms/recovery-card";
import { createRecoveryAuth } from "@/lib/browser-auth";

const resendDelay = 60_000;
const sentMessage = "หากอีเมลนี้ใช้กับระบบได้ คุณจะได้รับลิงก์ตั้งรหัสผ่านใหม่";

export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(false);
    const [retryAt, setRetryAt] = useState(0);
    const [secondsLeft, setSecondsLeft] = useState(0);
    const [unavailable, setUnavailable] = useState(false);
    const submitting = useRef(false);

    useEffect(() => {
        if (!retryAt) return;
        const timer = window.setInterval(() => {
            const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
            setSecondsLeft(remaining);
            if (!remaining) window.clearInterval(timer);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [retryAt]);

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting.current || Date.now() < retryAt) return;
        submitting.current = true;
        setBusy(true);
        setUnavailable(false);
        try {
            const auth = createRecoveryAuth().auth;
            const redirectTo = new URL("/reset-password", window.location.origin).href;
            // Keep the same public response for all Auth outcomes, including recipient-specific failures.
            await auth.resetPasswordForEmail(email.trim(), { redirectTo });
            setSent(true);
            setRetryAt(Date.now() + resendDelay);
            setSecondsLeft(resendDelay / 1000);
        } catch {
            setUnavailable(true);
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }

    return (
        <RecoveryCard title="ลืมรหัสผ่าน">
            <p className="muted">กรอกอีเมลที่ใช้เข้าสู่ระบบเพื่อขอลิงก์ตั้งรหัสผ่านใหม่</p>
            <form onSubmit={(event) => void submit(event)}>
                <label htmlFor="recovery-email">อีเมล</label>
                <Input
                    id="recovery-email"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                    disabled={busy}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                />
                {sent && <Notice tone="success">{sentMessage}</Notice>}
                {unavailable && <Notice tone="danger">ขอลิงก์ไม่ได้ในขณะนี้ กรุณาลองใหม่ภายหลัง</Notice>}
                <Button type="submit" className="auth-submit" disabled={busy || secondsLeft > 0}>
                    {busy ? "กำลังส่งคำขอ…" : secondsLeft > 0 ? `ส่งใหม่ได้ใน ${secondsLeft} วินาที` : "ส่งลิงก์ตั้งรหัสผ่านใหม่"}
                </Button>
                <Link className="quiet" href="/">
                    กลับไปเข้าสู่ระบบ
                </Link>
            </form>
        </RecoveryCard>
    );
}
