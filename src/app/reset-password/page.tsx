"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/dms/common";
import { RecoveryCard } from "@/components/dms/recovery-card";
import { createRecoveryAuth, getBrowserAuth } from "@/lib/browser-auth";

type Phase = "checking" | "confirm" | "invalid" | "password" | "revoke-error" | "done";
type RecoverySession = { auth: ReturnType<typeof createRecoveryAuth>["auth"]; userId: string };

export default function ResetPasswordPage() {
    const [phase, setPhase] = useState<Phase>("checking");
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const token = useRef<string | null>(null);
    const captured = useRef(false);
    const recovery = useRef<RecoverySession | null>(null);
    const lock = useRef(false);
    const passwordInput = useRef<HTMLInputElement>(null);
    const confirmationInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!captured.current) {
            const { hash, pathname, search } = window.location;
            const tokens = new URLSearchParams(hash.slice(1)).getAll("token_hash");
            if (tokens.length === 1 && /^[a-zA-Z0-9_-]{1,512}$/.test(tokens[0])) token.current = tokens[0];
            if (hash || search) window.history.replaceState(window.history.state, "", pathname);
            captured.current = true;
        }
        const timer = window.setTimeout(() => setPhase(token.current ? "confirm" : "invalid"), 0);
        return () => window.clearTimeout(timer);
    }, []);

    useEffect(() => {
        if (phase === "password") passwordInput.current?.focus();
    }, [phase]);

    async function verifyLink() {
        if (!token.current || lock.current) return;
        lock.current = true;
        setBusy(true);
        setMessage("");
        try {
            const auth = createRecoveryAuth().auth;
            const { data, error } = await auth.verifyOtp({ token_hash: token.current, type: "recovery" });
            if (error && (!error.status || error.status === 429 || error.status >= 500)) {
                setMessage("ยังตรวจสอบลิงก์ไม่ได้ กรุณารอสักครู่แล้วลองอีกครั้ง");
                return;
            }
            token.current = null;
            if (error || !data.session || !data.user) {
                setPhase("invalid");
                return;
            }
            recovery.current = { auth, userId: data.user.id };
            setPhase("password");
        } catch {
            setMessage("ยังตรวจสอบลิงก์ไม่ได้ กรุณารอสักครู่แล้วลองอีกครั้ง");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }

    async function revokeSessions(session: RecoverySession) {
        try {
            const { data, error: sessionError } = await session.auth.getSession();
            if (sessionError || !data.session) {
                setPhase("revoke-error");
                return;
            }
            // Use the verified user's bearer token for global sign-out. The SDK's regular
            // signOut() may clear its session on failure, which would prevent retrying.
            const { error } = await session.auth.admin.signOut(data.session.access_token, "global");
            if (error) {
                setPhase("revoke-error");
                return;
            }
        } catch {
            setPhase("revoke-error");
            return;
        }
        recovery.current = null;
        try {
            const normalAuth = getBrowserAuth().auth;
            const current = await normalAuth.getSession();
            if (current.data.session?.user.id === session.userId) {
                await normalAuth.signOut({ scope: "local" });
            }
        } catch {
            setMessage("หากเบราว์เซอร์นี้ยังแสดงบัญชีเดิม ให้กดออกจากระบบแล้วเข้าสู่ระบบใหม่");
        }
        setPhase("done");
    }

    async function updatePassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const session = recovery.current;
        if (!session || phase !== "password" || lock.current) return;
        if (password.length < 12) {
            setMessage("รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
            passwordInput.current?.focus();
            return;
        }
        if (password !== confirmation) {
            setMessage("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
            confirmationInput.current?.focus();
            return;
        }
        lock.current = true;
        setBusy(true);
        setMessage("");
        try {
            const { error } = await session.auth.updateUser({ password });
            if (error) {
                if (error.status === 401 || error.code === "session_expired" || error.code === "session_not_found") {
                    recovery.current = null;
                    setPassword("");
                    setConfirmation("");
                    setPhase("invalid");
                } else if (error.code === "same_password") {
                    setMessage("กรุณาเลือกรหัสผ่านใหม่ที่ต่างจากรหัสผ่านเดิม");
                } else if (error.code === "weak_password") {
                    setMessage("รหัสผ่านยังไม่ผ่านข้อกำหนด กรุณาเลือกรหัสผ่านที่รัดกุมขึ้น");
                } else {
                    setMessage("ตั้งรหัสผ่านไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองใหม่");
                }
                return;
            }
            setPassword("");
            setConfirmation("");
            await revokeSessions(session);
        } catch {
            setMessage("ตั้งรหัสผ่านไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองใหม่");
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }

    async function retryRevocation() {
        const session = recovery.current;
        if (!session || lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            await revokeSessions(session);
        } finally {
            lock.current = false;
            setBusy(false);
        }
    }

    return (
        <RecoveryCard title="ตั้งรหัสผ่านใหม่">
            {phase === "checking" && <p role="status">กำลังเปิดลิงก์ตั้งรหัสผ่าน…</p>}
            {phase === "confirm" && (
                <>
                    <p className="muted">กดดำเนินการต่อเพื่อยืนยันลิงก์จากอีเมล</p>
                    {message && <Notice tone="danger">{message}</Notice>}
                    <Button type="button" className="auth-submit" disabled={busy} onClick={() => void verifyLink()}>
                        {busy ? "กำลังตรวจสอบลิงก์…" : "ดำเนินการต่อ"}
                    </Button>
                </>
            )}
            {phase === "invalid" && (
                <>
                    <Notice tone="warning">ลิงก์นี้ใช้ไม่ได้ หมดอายุ หรือถูกใช้แล้ว กรุณาขอลิงก์ใหม่</Notice>
                    <Link className="secondary" href="/forgot-password">
                        ขอลิงก์ใหม่
                    </Link>
                </>
            )}
            {phase === "password" && (
                <form noValidate onSubmit={(event) => void updatePassword(event)}>
                    <label htmlFor="recovery-password">รหัสผ่านใหม่</label>
                    <Input
                        id="recovery-password"
                        ref={passwordInput}
                        type="password"
                        autoComplete="new-password"
                        aria-describedby="recovery-password-help"
                        minLength={12}
                        required
                        disabled={busy}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                    />
                    <small id="recovery-password-help">ใช้รหัสผ่านอย่างน้อย 12 ตัวอักษร</small>
                    <label htmlFor="recovery-confirmation">ยืนยันรหัสผ่านใหม่</label>
                    <Input
                        id="recovery-confirmation"
                        ref={confirmationInput}
                        type="password"
                        autoComplete="new-password"
                        required
                        disabled={busy}
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                    />
                    {message && <Notice tone="danger">{message}</Notice>}
                    <Button type="submit" className="auth-submit" disabled={busy}>
                        {busy ? "กำลังบันทึก…" : "บันทึกรหัสผ่านใหม่"}
                    </Button>
                </form>
            )}
            {phase === "revoke-error" && (
                <>
                    <Notice tone="warning">เปลี่ยนรหัสผ่านแล้ว แต่ยังยืนยันการออกจากระบบอุปกรณ์อื่นไม่ได้</Notice>
                    <Button type="button" className="auth-submit" disabled={busy} onClick={() => void retryRevocation()}>
                        {busy ? "กำลังออกจากระบบ…" : "ลองออกจากระบบทุกอุปกรณ์อีกครั้ง"}
                    </Button>
                </>
            )}
            {phase === "done" && (
                <>
                    <Notice tone="success">ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว คุณใช้รหัสผ่านใหม่เข้าสู่ระบบได้</Notice>
                    {message && <Notice tone="warning">{message}</Notice>}
                    <Link className="secondary" href="/">
                        กลับไปเข้าสู่ระบบ
                    </Link>
                </>
            )}
        </RecoveryCard>
    );
}
