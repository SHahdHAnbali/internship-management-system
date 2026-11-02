import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal dialog on the native <dialog> element (focus trap, Esc to close, top layer). Content is rendered only while open.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(480px,95vw)] rounded-card border-0 bg-surface p-0 text-body shadow-raised backdrop:bg-overlay"
    >
      {open && (
        <div className="p-6">
          <h2 id={titleId} className="text-h2 font-bold text-heading">
            {title}
          </h2>
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
