"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";

/*
 * Modal for small forms (invite someone, add an API, add a data source, …).
 * Built on <dialog>.showModal(): focus stays inside, Esc closes, the page behind is inert, and
 * focus returns to the button that opened it. Clicking the backdrop closes it too, unless `busy`.
 *
 *   <Modal open={open} onClose={() => setOpen(false)} title="Invite people" description="…">
 *     <form>…</form>
 *   </Modal>
 */
/** Whether a point is outside the dialog's box (on the backdrop). */
function outside(d: HTMLElement, x: number, y: number) {
  const r = d.getBoundingClientRect();
  return x < r.left || x > r.right || y < r.top || y > r.bottom;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  size = "md",
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** While true, Esc and the backdrop don't close it (a request is running). */
  busy?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  /** Whether the current press started on the backdrop (outside the box). */
  const pressedOutside = useRef(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onPointerDown={(e) => {
        pressedOutside.current = e.target === e.currentTarget && outside(e.currentTarget, e.clientX, e.clientY);
      }}
      onClick={(e) => {
        // Close only when the press started and ended on the backdrop, so a drag that ends outside,
        // or a click on a control's hidden part, never closes it.
        const close = pressedOutside.current && e.target === e.currentTarget && outside(e.currentTarget, e.clientX, e.clientY);
        pressedOutside.current = false;
        if (close && !busy) onClose();
      }}
    >
      {open && (
        <div className="modal-body">
          <header className="flex items-start gap-3">
            {icon && <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-weak text-primary">{icon}</div>}
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-[17px] font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-0.5 text-[13.5px] text-ink-2">
                  {description}
                </p>
              )}
            </div>
            <button type="button" className="btn btn-g btn-sm btn-icon -mr-1.5 -mt-1" aria-label="Close" onClick={onClose} disabled={busy}>
              <X size={16} aria-hidden />
            </button>
          </header>
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}

/** The footer row of a modal form: secondary actions left, Cancel + primary right. */
export function ModalActions({ children, left }: { children: ReactNode; left?: ReactNode }) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-line pt-4">
      <div className="mr-auto min-w-0 text-[13px] text-ink-2">{left}</div>
      {children}
    </div>
  );
}
