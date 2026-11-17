"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "./common";

type Factor = { id: string; friendly_name?: string };
type Phase = "loading" | "enroll" | "verify" | "verified" | "error";

function failureMessage(error: unknown) {
    const { code, status } = (error ?? {}) as { code?: string; status?: number };
    if (status === 429 || code === "mfa_verification_rejected") return "ลองยืนยันถี่เกินไป กรุณารอสักครู่ก่อนลองใหม่";
    if (code === "mfa_verification_failed") return "รหัสไม่ถูกต้อง กรุณาใช้รหัสล่าสุดจากแอป Authenticator และตรวจเวลาบนอุปกรณ์";
    if (code === "mfa_challenge_expired") return "คำขอยืนยันหมดอายุ กรุณากรอกรหัสล่าสุดแล้วกดยืนยันอีกครั้ง";
    if (code === "too_many_enrolled_mfa_factors") return "มีการลงทะเบียนอุปกรณ์ค้างอยู่หลายรายการ กรุณาติดต่อ IT เพื่อจัดการก่อนเริ่มใหม่";
    if (code === "mfa_factor_not_found" || code === "mfa_required") return "อุปกรณ์ยืนยันตัวตนเปลี่ยนไป กรุณาโหลดสถานะใหม่หรือติดต่อ IT";
    if (status === 401 || code === "session_expired" || code === "session_not_found") return "การเข้าสู่ระบบหมดอายุ กรุณากลับไปเข้าสู่ระบบใหม่";
    return "ยังตรวจสอบ MFA ไม่สำเร็จ กรุณาตรวจเครือข่ายแล้วลองอีกครั้ง หากยังพบปัญหาให้ติดต่อ IT";
}

// The same UI uses either the ordinary browser client or the isolated recovery
// client. Never transfer recovery tokens into the browser's persisted session.
export function MfaChallenge({ auth, onVerified, onCancel, allowEnroll = true }: {
    auth: SupabaseClient["auth"];
    onVerified: () => Promise<void>;
    onCancel?: () => Promise<void>;
    allowEnroll?: boolean;
}) {
    const [phase, setPhase] = useState<Phase>("loading");
    const [factors, setFactors] = useState<Factor[]>([]);
    const [factorId, setFactorId] = useState("");
    const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
    const [code, setCode] = useState("");
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const lock = useRef(false);
    const generation = useRef(0);

    useEffect(() => {
        const ticket = ++generation.current;
        void auth.mfa.listFactors().then(({ data, error }) => {
            if (ticket !== generation.current) return;
            if (error) throw error;
            const verified = data.totp.filter((factor) => factor.status === "verified");
            setFactors(verified);
            setFactorId(verified[0]?.id ?? "");
            setSetup(null);
            setCode("");
            if (verified.length) setPhase("verify");
            else if (allowEnroll && !data.all.some((factor) => factor.status === "verified")) setPhase("enroll");
            else {
                setMessage("ไม่พบอุปกรณ์ TOTP ที่ใช้ยืนยันได้ กรุณาติดต่อ IT");
                setPhase("error");
            }
        }).catch((error: unknown) => {
            if (ticket !== generation.current) return;
            setMessage(failureMessage(error));
            setPhase("error");
        });
        return () => { generation.current = ticket + 1; };
    }, [auth, allowEnroll, reload]);

    useEffect(() => { if (phase === "verify" && !busy) input.current?.focus(); }, [phase, busy]);

    async function run(action: () => Promise<void>) {
        if (lock.current) return;
        const ticket = generation.current;
        lock.current = true;
        setBusy(true);
        setMessage("");
        try { await action(); }
        catch (error) {
            if (ticket === generation.current) {
                setMessage(failureMessage(error));
                if ((error as { code?: string })?.code === "mfa_required") setPhase("error");
            }
        }
        finally {
            lock.current = false;
            if (ticket === generation.current) setBusy(false);
        }
    }

    async function enroll() {
        const ticket = generation.current;
        const { data, error } = await auth.mfa.enroll({ factorType: "totp", friendlyName: `EFIN DMS ${crypto.randomUUID()}`, issuer: "EFIN DMS" });
        if (error) throw error;
        if (ticket !== generation.current) return;
        setFactorId(data.id);
        // The SDK returns a data:image/svg+xml URL. Render as an image, never HTML.
        setSetup({ qr: data.totp.qr_code, secret: data.totp.secret });
        setPhase("verify");
    }

    async function verify(event: FormEvent) {
        event.preventDefault();
        if (lock.current) return;
        if (!/^\d{6}$/.test(code)) {
            setMessage("กรุณากรอกรหัส 6 หลักจากแอป Authenticator");
            input.current?.focus();
            return;
        }
        await run(async () => {
            const ticket = generation.current;
            const submittedCode = code;
            setCode("");
            const { error } = await auth.mfa.challengeAndVerify({ factorId, code: submittedCode });
            if (error) throw error;
            if (ticket !== generation.current) return;
            setSetup(null);
            setPhase("verified");
            await onVerified();
        });
    }

    return (
        <section className="mfa-flow" aria-label="ยืนยันตัวตนสองขั้นตอน" aria-busy={busy}>
            {phase === "loading" && <p role="status">กำลังตรวจอุปกรณ์ยืนยันตัวตน…</p>}
            {phase === "enroll" && <>
                <p>ตั้งค่าแอป Authenticator เพื่อยืนยันตัวตนก่อนเข้าถึงข้อมูลด้วยบัญชีผู้ดูแลองค์กร</p>
                <Notice tone="warning">การยืนยันการตั้งค่า MFA อาจทำให้บัญชีนี้ต้องเข้าสู่ระบบใหม่บนอุปกรณ์อื่น</Notice>
                <Button className="auth-submit" disabled={busy} onClick={() => void run(enroll)}>
                    {busy ? "กำลังเริ่มตั้งค่า…" : "เริ่มตั้งค่า MFA"}
                </Button>
            </>}
            {phase === "verify" && <form noValidate onSubmit={(event) => void verify(event)}>
                {setup ? <>
                    <p>1. เปิดแอป Authenticator แล้วสแกน QR code</p>
                    {/* This private in-memory data URL must not go through an image optimizer. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="mfa-qr" src={setup.qr} alt="QR code สำหรับตั้งค่า Authenticator" width={224} height={224} />
                    <details><summary>สแกนไม่ได้? แสดงรหัสสำหรับกรอกเอง</summary>
                        <p>เก็บรหัสนี้เป็นความลับ ไม่ส่งให้ผู้อื่น</p><code className="mfa-secret">{setup.secret}</code>
                    </details>
                    <p>2. กรอกรหัสที่แอปแสดงเพื่อยืนยันการตั้งค่า</p>
                </> : <p>เปิดแอป Authenticator แล้วกรอกรหัสปัจจุบันเพื่อเข้าใช้งาน</p>}
                {!setup && factors.length > 1 && <>
                    <label htmlFor="mfa-factor">อุปกรณ์ยืนยันตัวตน</label>
                    <select id="mfa-factor" value={factorId} disabled={busy} onChange={(event) => { setFactorId(event.target.value); setCode(""); }}>
                        {factors.map((factor, index) => <option key={factor.id} value={factor.id}>{factor.friendly_name || `Authenticator ${index + 1}`}</option>)}
                    </select>
                </>}
                <label htmlFor="mfa-code">รหัสยืนยัน 6 หลัก</label>
                <Input id="mfa-code" ref={input} value={code} onChange={(event) => setCode(event.target.value.replace(/\s/g, ""))}
                    inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required disabled={busy}
                    aria-describedby={message ? "mfa-message" : "mfa-help"} aria-invalid={Boolean(message)} />
                <small id="mfa-help">ใช้รหัสล่าสุด และเปิดการตั้งเวลาอัตโนมัติบนอุปกรณ์</small>
                <Button className="auth-submit" type="submit" disabled={busy}>{busy ? "กำลังยืนยัน…" : "ยืนยันรหัส"}</Button>
            </form>}
            {phase === "verified" && <>
                <p role="status">ยืนยัน MFA แล้ว กำลังตรวจสิทธิ์เข้าใช้งาน</p>
                <Button className="auth-submit" disabled={busy} onClick={() => void run(onVerified)}>ตรวจสิทธิ์อีกครั้ง</Button>
            </>}
            {message && <div id="mfa-message"><Notice tone="danger">{message}</Notice></div>}
            {(phase === "error" || (message && phase === "verify" && !setup)) && <Button type="button" disabled={busy} onClick={() => {
                setMessage(""); setPhase("loading"); setReload((value) => value + 1);
            }}>โหลดสถานะใหม่</Button>}
            <p className="muted">หากอุปกรณ์หายหรือต้องการเปลี่ยนอุปกรณ์ กรุณาติดต่อ IT เพื่อยืนยันตัวตนและรีเซ็ต MFA</p>
            {onCancel && <Button type="button" variant="outline" disabled={busy} onClick={() => void run(onCancel)}>ออกจากระบบบัญชีนี้</Button>}
        </section>
    );
}
