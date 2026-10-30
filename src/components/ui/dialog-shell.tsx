"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

type DialogShellProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    children: ReactNode;
};

export function DialogShell({ open, onOpenChange, title, children }: DialogShellProps) {
    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="modal-overlay" />
                <Dialog.Content className="modal-content" aria-describedby={undefined}>
                    <Dialog.Title className="sr-only">{title}</Dialog.Title>
                    {children}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
