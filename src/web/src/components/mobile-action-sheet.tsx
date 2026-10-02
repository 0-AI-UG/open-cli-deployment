import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useDialogFocus } from "../hooks/use-dialog-focus.ts";

export function MobileActionSheet({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useDialogFocus(open, sheetRef);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[85] flex items-end" role="presentation">
      <button
        aria-label="Close actions"
        className="absolute inset-0 animate-fade-in bg-black/40 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-h-[82dvh] animate-slide-up overflow-y-auto rounded-t-2xl border border-b-0 bg-canvas px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-3 shadow-pop"
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line-strong" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-fg">{title}</h2>
            {subtitle && <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted active:bg-subtle"
          >
            <X size={20} />
          </button>
        </div>
        <div className="space-y-2">{children}</div>
      </section>
    </div>
  );
}

export function MobileSheetAction({
  icon,
  label,
  detail,
  danger = false,
  primary = false,
  disabled = false,
  loading = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`flex min-h-14 w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors disabled:opacity-50 ${
        danger ? "border-danger/25 bg-danger/5 text-danger active:bg-danger/10" : primary ? "border-primary bg-primary text-primary-fg active:opacity-90" : "bg-surface text-fg active:bg-subtle"
      }`}
    >
      <span className={`shrink-0 ${loading ? "animate-spin" : ""} ${danger || primary ? "" : "text-muted"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{loading ? `${label}…` : label}</span>
        {detail && <span className={`mt-0.5 block text-sm ${danger ? "text-danger/80" : primary ? "text-primary-fg/70" : "text-muted"}`}>{detail}</span>}
      </span>
    </button>
  );
}
