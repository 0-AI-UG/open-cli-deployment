import { useState, useEffect, useRef, useLayoutEffect, useId } from "react";
import { createPortal } from "react-dom";
import { portalAnchorRect } from "./ui.tsx";

export type SelectOption = { value: string; label: string };

export function NeoSelect({ value, options, onChange, placeholder, compact, disabled }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find(o => o.value === value);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    setHighlighted(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, options, value]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      const r = portalAnchorRect(triggerRef.current);
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlighted((index) => (index + direction + options.length) % Math.max(1, options.length));
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(highlighted);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        aria-activedescendant={open && options[highlighted] ? `${listboxId}-${highlighted}` : undefined}
        className={`flex w-full items-center rounded-md border bg-surface text-left shadow-xs transition-[border-color,box-shadow] ${
          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-muted/60"
        } ${compact ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-sm max-md:h-11 max-md:text-base"
        } ${open ? "border-ring ring-[3px] ring-ring/20" : "border-line-strong"}`}
      >
        <span className={`flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${(!value && placeholder) ? "text-muted" : "text-fg"}`}>
          {selected?.label || value || placeholder || ""}
        </span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`ml-1.5 flex-shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          data-neoselect-menu
          style={{ position: "fixed", top: pos.top, left: pos.left, minWidth: pos.width }}
          className="z-[95] max-h-64 animate-pop-in overflow-auto rounded-lg border bg-surface p-1 shadow-pop"
        >
          {options.length === 0 && (
            <div className={`text-muted ${compact ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-sm"}`}>
              No options
            </div>
          )}
          {options.map(opt => (
            <button
              key={opt.value}
              id={`${listboxId}-${options.indexOf(opt)}`}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              onMouseEnter={() => setHighlighted(options.indexOf(opt))}
              onClick={() => choose(options.indexOf(opt))}
              className={`flex w-full cursor-pointer items-center justify-between gap-3 rounded-md text-left text-fg ${
                compact ? "px-2 py-1 text-xs" : "px-2.5 py-1.5 text-sm max-md:py-2.5 max-md:text-base"
              } ${options.indexOf(opt) === highlighted ? "bg-subtle" : "bg-transparent"} ${opt.value === value ? "font-medium" : ""}`}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-fg"><polyline points="20 6 9 17 4 12" /></svg>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
