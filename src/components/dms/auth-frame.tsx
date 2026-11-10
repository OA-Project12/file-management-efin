import Link from "next/link";
import type { ReactNode } from "react";

export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
    return (
        <main className="auth-page">
            <section className="auth-card" aria-labelledby="auth-title">
                <div className="auth-form-wrap">
                    <Link className="indigo-brand auth-brand" href="/" aria-label="EFIN DMS หน้าเข้าสู่ระบบ">
                        <span className="brand-mark" aria-hidden="true"><span /></span>EFIN DMS
                    </Link>
                    <h1 id="auth-title">{title}</h1>
                    {children}
                </div>
            </section>
            <div className="auth-folio" aria-hidden="true" />
        </main>
    );
}
