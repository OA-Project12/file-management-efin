"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserAuth } from "@/lib/browser-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function SetPasswordPage() {
    const router = useRouter();
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [message, setMessage] = useState("");
    const [busy, setBusy] = useState(false);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (password.length < 12) {
            setMessage("รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร");
            return;
        }
        setBusy(true);
        try {
            const auth = getBrowserAuth().auth;
            const {
                data: { session },
            } = await auth.getSession();
            if (!session) throw new Error("ลิงก์เชิญหมดอายุหรือไม่ถูกต้อง กรุณาขอคำเชิญใหม่");
            const { error } = await auth.updateUser({ password });
            if (error) throw error;
            router.push("/");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : "ตั้งรหัสผ่านไม่สำเร็จ");
        } finally {
            setBusy(false);
        }
    }

    return (
        <main className="login">
            <div className="login-visual"><div className="login-wordmark">EFIN</div><div><h2>เอกสารที่สำคัญ<br />อยู่ในที่ที่ใช่</h2><p>จัดเก็บ ค้นหา และทำงานร่วมกันได้อย่างมั่นใจในทุกหน่วยงาน</p></div><small>EFIN DMS · Document Management System</small></div>
            <div className="login-main"><form className="login-card" onSubmit={submit}>
                    <p>ยินดีต้อนรับสู่ EFIN DMS</p>
                    <h1>ตั้งรหัสผ่าน</h1>
                    <p>ตั้งรหัสผ่านสำหรับบัญชีที่ได้รับคำเชิญ</p>
                    <label>
                        รหัสผ่านใหม่
                        <Input
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            autoComplete="new-password"
                            minLength={12}
                            required
                        />
                    </label>
                    <p className="form-help">ใช้รหัสผ่านอย่างน้อย 12 ตัวอักษร สามารถวางจากตัวจัดการรหัสผ่านได้</p>
                    <button className="password-toggle" type="button" aria-pressed={showPassword} onClick={() => setShowPassword((current) => !current)}>{showPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}</button>
                    {message && <div className="notice" role="alert">{message}</div>}
                    <Button className="primary" disabled={busy}>
                        {busy ? "กำลังบันทึก…" : "ตั้งรหัสผ่าน"}
                    </Button>
                </form></div>
        </main>
    );
}
