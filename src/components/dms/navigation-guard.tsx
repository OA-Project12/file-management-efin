"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

type Entry = { dirty: boolean; busy: boolean };
const Guard = createContext<{
    navigate: (action: () => void) => void;
    register: (id: string, entry: Entry | null) => void;
    reset: () => void;
}>({ navigate: (action) => action(), register: () => {}, reset: () => {} });
export function NavigationGuardProvider({ children }: { children: ReactNode }) {
    const entries = useRef(new Map<string, Entry>());
    const [pending, setPending] = useState<(() => void) | null>(null);
    const [message, setMessage] = useState("");
    const register = useCallback((id: string, entry: Entry | null) => {
        if (entry) entries.current.set(id, entry);
        else entries.current.delete(id);
    }, []);
    const reset = useCallback(() => {
        setPending(null);
        setMessage("");
    }, []);
    const navigate = useCallback((action: () => void) => {
        const current = [...entries.current.values()];
        if (current.some((entry) => entry.busy)) {
            setMessage("กำลังดำเนินการ กรุณารอให้เสร็จก่อนเปลี่ยนหน้าหรือปิดแผง");
            return;
        }
        if (current.some((entry) => entry.dirty)) {
            setPending(() => action);
            return;
        }
        setMessage("");
        action();
    }, []);
    useEffect(() => {
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if ([...entries.current.values()].some((entry) => entry.dirty || entry.busy)) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, []);
    const value = useMemo(() => ({ navigate, register, reset }), [navigate, register, reset]);
    return (
        <Guard.Provider value={value}>
            {children}
            {message && (
                <div className="guard-notice" role="status">
                    {message}
                    <button onClick={() => setMessage("")} aria-label="ปิดคำแจ้งเตือน">
                        ปิด
                    </button>
                </div>
            )}
            <Dialog.Root
                open={Boolean(pending)}
                onOpenChange={(open) => {
                    if (!open) setPending(null);
                }}
            >
                <Dialog.Portal>
                    <Dialog.Overlay className="modal-overlay" />
                    <Dialog.Content className="modal-content modal-confirm">
                        <Dialog.Title>ละทิ้งการเปลี่ยนแปลง?</Dialog.Title>
                        <Dialog.Description>ข้อมูลที่แก้ไขยังไม่ได้บันทึก คุณกลับไปแก้ไขต่อได้</Dialog.Description>
                        <div className="dialog-actions">
                            <button className="secondary" onClick={() => setPending(null)}>
                                แก้ไขต่อ
                            </button>
                            <button
                                className="danger"
                                onClick={() => {
                                    const action = pending;
                                    setPending(null);
                                    setMessage("");
                                    action?.();
                                }}
                            >
                                ละทิ้ง
                            </button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </Guard.Provider>
    );
}
export const useNavigationGuard = () => useContext(Guard);
export function useUnsavedChanges(dirty: boolean, busy: boolean) {
    const id = useId(),
        { register } = useNavigationGuard();
    useEffect(() => {
        register(id, { dirty, busy });
        return () => register(id, null);
    }, [id, dirty, busy, register]);
}
