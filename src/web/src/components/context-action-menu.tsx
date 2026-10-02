import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, MoreHorizontal } from "lucide-react";
import { portalAnchorRect } from "./ui.tsx";

const MENU_WIDTH = 208;
const MENU_ESTIMATED_HEIGHT = 190;

export function ContextActionMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = portalAnchorRect(triggerRef.current);
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      const top = rect.bottom + 4 + MENU_ESTIMATED_HEIGHT > window.innerHeight
        ? Math.max(8, rect.top - MENU_ESTIMATED_HEIGHT - 4)
        : rect.bottom + 4;
      setPosition({ top, left });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className={`inline-grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-fg ${open ? "bg-subtle text-fg" : ""}`}
      >
        <MoreHorizontal size={16} />
      </button>

      {open && position && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          style={{ position: "fixed", top: position.top, left: position.left, width: MENU_WIDTH }}
          className="z-[70] max-h-[min(380px,calc(100vh-16px))] animate-pop-in overflow-y-auto bg-surface p-1 rounded-lg shadow-pop"
        >
          {children(close)}
        </div>,
        document.body,
      )}
    </>
  );
}

export function ContextActionItem({
  icon,
  label,
  onClick,
  disabled = false,
  loading = false,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled || loading}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${danger ? "text-danger hover:bg-danger/10 focus:bg-danger/10" : "text-fg hover:bg-subtle focus:bg-subtle"}`}
    >
      <span className={`grid h-4 w-4 shrink-0 place-items-center ${danger ? "" : "text-muted"}`}>
        {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
