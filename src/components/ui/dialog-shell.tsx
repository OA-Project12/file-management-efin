"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useId, useRef, useState, type ReactNode } from "react";
import { useUnsavedChanges } from "@/components/dms/navigation-guard";
export const DialogClose = Dialog.Close;

type DialogShellProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  description?: string;
  size?: "confirm" | "form" | "wide" | "sheet" | "drawer";
  dirty?: boolean;
  busy?: boolean;
  initialFocus?: "cancel";
};

export function DialogShell({
  open,
  onOpenChange,
  title,
  children,
  description,
  size = "form",
  dirty,
  busy = false,
  initialFocus,
}: DialogShellProps) {
  const [touched, setTouched] = useState(false);
  const [discard, setDiscard] = useState(false);
  const descriptionId = useId();
  const content = useRef<HTMLDivElement>(null);
  const changed = dirty ?? touched;
  useUnsavedChanges(open && changed, open && busy);
  function requestClose(next: boolean) {
    if (next) {
      setTouched(false);
      onOpenChange(true);
      return;
    }
    if (busy) return;
    if (changed) {
      setDiscard(true);
      return;
    }
    setTouched(false);
    onOpenChange(false);
  }
  return (
    <Dialog.Root open={open} onOpenChange={requestClose}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          ref={content}
          className={`modal-content modal-${size}`}
          aria-describedby={description ? descriptionId : undefined}
          onChange={() => setTouched(true)}
          onOpenAutoFocus={(event) => {
            if (initialFocus === "cancel") {
              event.preventDefault();
              content.current
                ?.querySelector<HTMLElement>("[data-cancel],button.secondary")
                ?.focus();
            }
          }}
        >
          <Dialog.Title asChild>
            <span className="sr-only">{title}</span>
          </Dialog.Title>
          {description && (
            <Dialog.Description id={descriptionId} className="sr-only">
              {description}
            </Dialog.Description>
          )}
          {children}
          <Dialog.Root open={discard} onOpenChange={setDiscard}>
            <Dialog.Portal>
              <Dialog.Overlay className="modal-overlay" />
              <Dialog.Content className="modal-content modal-confirm">
                <Dialog.Title>ละทิ้งการเปลี่ยนแปลง?</Dialog.Title>
                <Dialog.Description>
                  ข้อมูลที่แก้ไขยังไม่ได้บันทึก
                </Dialog.Description>
                <div className="dialog-actions">
                  <button
                    className="secondary"
                    onClick={() => setDiscard(false)}
                  >
                    แก้ไขต่อ
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setDiscard(false);
                      setTouched(false);
                      onOpenChange(false);
                    }}
                  >
                    ละทิ้ง
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
