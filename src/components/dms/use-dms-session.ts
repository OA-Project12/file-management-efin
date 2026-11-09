import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBrowserAuth } from "@/lib/browser-auth";
import type { Api, ApiError, Department, Identity } from "./model";

const sessionExpired = "การเข้าสู่ระบบหมดอายุ กรุณาเข้าสู่ระบบใหม่";
const membershipDenied = "บัญชีนี้ยังเข้าถึงพื้นที่เอกสารนี้ไม่ได้ โปรดติดต่อผู้ดูแล";
const suspended = "บัญชีนี้ถูกระงับการเข้าถึงพื้นที่เอกสาร โปรดติดต่อผู้ดูแล";
const activityHeader = { "X-DMS-Session-Activity": "1" };

function sessionMessage(error: unknown) {
    const code = (error as ApiError | undefined)?.code;
    if (code === "account_suspended") return suspended;
    if (code === "membership_denied") return membershipDenied;
    return sessionExpired;
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`/api/v1${path}`, { ...init, headers, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(new Error("api_request_failed"), {
            code: body.error?.code,
            status: response.status,
            details: body.error?.details,
            retryAfter: Number(response.headers.get("Retry-After")) || undefined,
        });
    }
    return body as T;
}

export function useDmsSession(resetWorkspace: () => void) {
    const router = useRouter();
    const [phase, setPhase] = useState<"checking" | "login" | "ready">("checking");
    const [identity, setIdentity] = useState<Identity | null>(null);
    const [authError, setAuthError] = useState("");
    const generation = useRef(0);
    const currentUser = useRef<string | null>(null);
    const invalidate = useCallback(() => ++generation.current, []);

    const endSession = useCallback(
        (message = "") => {
            invalidate();
            currentUser.current = null;
            setIdentity(null);
            setAuthError(message);
            setPhase("login");
            resetWorkspace();
        },
        [invalidate, resetWorkspace],
    );

    const assertCurrent = useCallback((ticket: number) => {
        if (ticket !== generation.current) throw new DOMException("Session changed", "AbortError");
    }, []);

    const authenticatedRequest = useCallback(
        async <T>(path: string, init?: RequestInit): Promise<T> => {
            const ticket = generation.current;
            const userId = currentUser.current;
            if (!userId) throw new DOMException("Session changed", "AbortError");
            const {
                data: { session },
                error,
            } = await getBrowserAuth().auth.getSession();
            assertCurrent(ticket);
            if (error?.name === "AuthRetryableFetchError" || (error?.status ?? 0) >= 500) throw error;
            if (session?.user.id !== userId) {
                endSession(sessionExpired);
                throw Object.assign(new Error("unauthorized"), { code: "unauthorized", status: 401 });
            }
            try {
                const result = await request<T>(path, session.access_token, init);
                assertCurrent(ticket);
                return result;
            } catch (error) {
                assertCurrent(ticket);
                if ((error as ApiError).status === 401) endSession(sessionMessage(error));
                throw error;
            }
        },
        [assertCurrent, endSession],
    );

    const api: Api = authenticatedRequest;
    const loadIdentity = useCallback(
        async (token: string, userId: string, ticket: number) => {
            const current = await request<Identity>("/me", token, { headers: activityHeader });
            assertCurrent(ticket);
            if (current.userId !== userId) throw new Error("identity_mismatch");
            const departments = await request<{ data: { items: Department[] } }>("/departments", token);
            assertCurrent(ticket);
            resetWorkspace();
            currentUser.current = userId;
            setIdentity({ ...current, departments: departments.data.items });
            setAuthError("");
            setPhase("ready");
        },
        [assertCurrent, resetWorkspace],
    );

    useEffect(() => {
        if (new URLSearchParams(window.location.hash.slice(1)).get("type") === "invite") {
            router.replace(`/set-password${window.location.search}${window.location.hash}`);
            return;
        }
        let unsubscribe: (() => void) | undefined;
        const timer = window.setTimeout(async () => {
            const ticket = generation.current;
            try {
                const auth = getBrowserAuth().auth;
                const {
                    data: { subscription },
                } = auth.onAuthStateChange((event, session) => {
                    // The callback stays synchronous. The SDK holds its auth lock here.
                    if (
                        currentUser.current &&
                        (event === "SIGNED_OUT" || (event === "SIGNED_IN" && session?.user.id !== currentUser.current))
                    ) {
                        endSession(sessionExpired);
                    }
                });
                unsubscribe = () => subscription.unsubscribe();
                const {
                    data: { session },
                    error,
                } = await auth.getSession();
                assertCurrent(ticket);
                if (error && error.name !== "AuthSessionMissingError") throw error;
                if (session) await loadIdentity(session.access_token, session.user.id, ticket);
                else endSession();
            } catch (error) {
                if (ticket !== generation.current) return;
                endSession(
                    (error as ApiError).status === 401
                        ? sessionMessage(error)
                        : "ตรวจสอบการเข้าสู่ระบบไม่สำเร็จ กรุณาตรวจเครือข่ายและลองใหม่",
                );
            }
        }, 0);
        return () => {
            window.clearTimeout(timer);
            unsubscribe?.();
            invalidate();
        };
    }, [assertCurrent, endSession, invalidate, loadIdentity, router]);

    useEffect(() => {
        if (phase !== "ready") return;
        let interacted = false;
        let pending = false;
        const markActivity = (event: Event) => {
            if (event.isTrusted && document.visibilityState === "visible") interacted = true;
        };
        const check = async () => {
            if (pending || document.visibilityState !== "visible") return;
            pending = true;
            const touch = interacted;
            interacted = false;
            try {
                await authenticatedRequest("/me", touch ? { headers: activityHeader } : undefined);
            } catch (error) {
                if ((error as ApiError).status !== 401) interacted ||= touch;
            } finally {
                pending = false;
            }
        };
        const timer = window.setInterval(() => void check(), 30_000);
        const activityEvents = ["pointerdown", "keydown", "wheel", "touchmove"] as const;
        for (const event of activityEvents) window.addEventListener(event, markActivity, { passive: true });
        document.addEventListener("visibilitychange", check);
        window.addEventListener("pageshow", check);
        return () => {
            window.clearInterval(timer);
            for (const event of activityEvents) window.removeEventListener(event, markActivity);
            document.removeEventListener("visibilitychange", check);
            window.removeEventListener("pageshow", check);
        };
    }, [authenticatedRequest, phase]);

    async function login(email: string, password: string) {
        const ticket = invalidate();
        setAuthError("");
        try {
            const { data, error } = await getBrowserAuth().auth.signInWithPassword({ email, password });
            assertCurrent(ticket);
            if (error || !data.session) throw error ?? new Error("missing_session");
            await loadIdentity(data.session.access_token, data.session.user.id, ticket);
        } catch (error) {
            if (ticket !== generation.current) return;
            const failure = error as ApiError;
            setAuthError(
                failure.code === "invalid_credentials"
                    ? "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
                    : failure.status === 401
                      ? sessionMessage(error)
                      : "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจข้อมูลและเครือข่ายแล้วลองใหม่",
            );
        }
    }

    async function logout() {
        const auth = getBrowserAuth().auth;
        const { error } = await auth.signOut({ scope: "local" });
        if (error) {
            const { data: current, error: sessionError } = await auth.getSession();
            if (current.session || (sessionError && sessionError.name !== "AuthSessionMissingError")) throw error;
            endSession("ออกจากระบบในเบราว์เซอร์แล้ว แต่ยังยืนยันการสิ้นสุด session กับเซิร์ฟเวอร์ไม่ได้");
            return;
        }
        endSession();
    }

    return { api, phase, identity, setIdentity, authError, login, logout };
}
