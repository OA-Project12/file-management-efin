"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserAuth } from "@/lib/browser-auth";

export default function SetPasswordPage() {
    const router = useRouter();
    const [password, setPassword] = useState("");
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
            <form className="login-card" onSubmit={submit}>
                <div className="logo">E</div>
                <h1>ตั้งรหัสผ่าน</h1>
                <p>ตั้งรหัสผ่านสำหรับบัญชีที่ได้รับคำเชิญ</p>
                <label>
                    รหัสผ่านใหม่
                    <input
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                        minLength={12}
                        required
                    />
                </label>
                <button className="primary" disabled={busy}>
                    {busy ? "กำลังบันทึก…" : "ตั้งรหัสผ่าน"}
                </button>
                {message && <div className="notice">{message}</div>}
            </form>
        </main>
    );
}
