import Link from "next/link";
import type { ReactNode } from "react";

export function RecoveryCard({ title, children }: { title: string; children: ReactNode }) {
    return (
        <main className="auth-page">
            <section className="auth-card" aria-labelledby="recovery-title">
                <Link className="brand" href="/" aria-label="EFIN DMS หน้าแรก">
                    <span className="brand-mark">E</span>
                    <span>
                        EFIN <strong>DMS</strong>
                    </span>
                </Link>
                <h1 id="recovery-title">{title}</h1>
                {children}
                <p className="auth-footer">EFIN Document Management System</p>
            </section>
        </main>
    );
}
