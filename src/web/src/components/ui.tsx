import React, { useState, useEffect, useCallback, useId, useRef, type ReactNode } from "react";
import { AlertTriangle, AlertCircle, ArrowLeft, Check, CheckCircle2, Copy, Info, Loader2, XCircle } from "lucide-react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
import { useDialogFocus } from "../hooks/use-dialog-focus.ts";
export { portalAnchorRect } from "./portal-position.ts";

// --- Toast system ---
type Toast = {
  id: number;
  message: string;
  subtitle?: string;
  type: "success" | "error" | "info";
  sticky?: boolean;
};
let toastId = 0;
let toastListeners: Array<(toasts: Toast[]) => void> = [];
let currentToasts: Toast[] = [];

function notifyToastListeners() {
  toastListeners.forEach((l) => l([...currentToasts]));
}

export function showToast(message: string, type: Toast["type"] = "info") {
  const id = ++toastId;
  currentToasts = [...currentToasts, { id, message, type }];
  notifyToastListeners();
  setTimeout(() => {
    currentToasts = currentToasts.filter((t) => t.id !== id);
    notifyToastListeners();
  }, 4000);
}

/**
 * Create a sticky toast whose message / subtitle / type can be updated in place
 * and which is dismissed explicitly. Used for long-running engine operations.
 */
export function showLiveToast(init: { message: string; subtitle?: string; type?: Toast["type"] }): {
  update: (patch: Partial<Pick<Toast, "message" | "subtitle" | "type">>) => void;
  dismiss: (afterMs?: number) => void;
} {
  const id = ++toastId;
  currentToasts = [
    ...currentToasts,
    { id, message: init.message, subtitle: init.subtitle, type: init.type ?? "info", sticky: true },
  ];
  notifyToastListeners();
  return {
    update: (patch) => {
      currentToasts = currentToasts.map((t) => (t.id === id ? { ...t, ...patch } : t));
      notifyToastListeners();
    },
    dismiss: (afterMs = 0) => {
      setTimeout(() => {
        currentToasts = currentToasts.filter((t) => t.id !== id);
        notifyToastListeners();
      }, afterMs);
    },
  };
}

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const isMobile = useMobileLayout();

  useEffect(() => {
    toastListeners.push(setToasts);
    return () => { toastListeners = toastListeners.filter((l) => l !== setToasts); };
  }, []);

  return (
    <div aria-live="polite" aria-relevant="additions text" className={isMobile ? "pointer-events-none fixed inset-x-3 top-[calc(60px+env(safe-area-inset-top))] z-[100] flex flex-col gap-2" : "pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[360px] flex-col gap-2"}>
      {toasts.map((t) => {
        const Icon = t.type === "success" ? CheckCircle2 : t.type === "error" ? XCircle : t.sticky ? Loader2 : Info;
        const tone = t.type === "success" ? "text-success" : t.type === "error" ? "text-danger" : "text-info";
        const spinning = t.sticky && t.type === "info";
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex w-full animate-slide-up items-start gap-3 rounded-lg border bg-surface px-3.5 py-3 shadow-pop"
          >
            <Icon size={16} className={`mt-0.5 shrink-0 ${tone} ${spinning ? "animate-spin" : ""}`} />
            <div className="min-w-0 flex-1">
              <div className="break-words text-sm font-medium text-fg">{t.message}</div>
              {t.subtitle && <div className="mt-0.5 break-words text-xs text-muted">{t.subtitle}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// --- Confirm Dialog ---
type ConfirmState = {
  open: boolean;
  title: string;
  message: string;
  danger?: boolean;
  requiredText?: string;
  requiredTextLabel?: string;
  resolve?: (v: boolean) => void;
};

let confirmState: ConfirmState = { open: false, title: "", message: "" };
let confirmListeners: Array<(s: ConfirmState) => void> = [];

function notifyConfirmListeners() {
  confirmListeners.forEach((l) => l({ ...confirmState }));
}

export function confirm(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { open: true, title, message, danger, resolve };
    notifyConfirmListeners();
  });
}

export function confirmWithText(
  title: string,
  message: string,
  requiredText: string,
  requiredTextLabel: string,
  danger = true,
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { open: true, title, message, danger, requiredText, requiredTextLabel, resolve };
    notifyConfirmListeners();
  });
}

export function ConfirmDialog() {
  const [state, setState] = useState<ConfirmState>({ open: false, title: "", message: "" });
  const [typedText, setTypedText] = useState("");
  const isMobile = useMobileLayout();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(state.open, dialogRef);

  useEffect(() => {
    confirmListeners.push(setState);
    return () => { confirmListeners = confirmListeners.filter((l) => l !== setState); };
  }, []);

  useEffect(() => {
    setTypedText("");
  }, [state.open, state.requiredText]);

  useEffect(() => {
    if (!state.open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [state.open]);

  if (!state.open) return null;

  const close = (v: boolean) => {
    state.resolve?.(v);
    confirmState = { open: false, title: "", message: "" };
    notifyConfirmListeners();
  };

  return (
    <div className={`fixed inset-0 z-[90] flex animate-fade-in bg-black/40 backdrop-blur-[2px] ${isMobile ? "items-end" : "items-center justify-center p-4"}`}>
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-message" className={isMobile ? "w-full max-h-[90dvh] overflow-y-auto rounded-t-2xl border border-b-0 bg-surface px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 shadow-pop animate-slide-up" : "w-full max-w-md animate-pop-in overflow-hidden rounded-xl border bg-surface shadow-pop"}>
        {isMobile && <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line-strong" />}
        <div className={isMobile ? "" : "p-5"}>
          <div className="flex items-start gap-3">
            {state.danger && (
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-danger/10 text-danger">
                <AlertTriangle size={17} />
              </span>
            )}
            <div className="min-w-0 pt-0.5">
              <h3 id="confirm-dialog-title" className="text-base font-semibold text-fg">{state.title}</h3>
              <p id="confirm-dialog-message" className="mt-1.5 break-words text-sm text-fg-dim">{state.message}</p>
            </div>
          </div>
          {state.requiredText !== undefined && (
            <div className="mt-4">
              <label className="mb-1.5 block text-sm text-fg-dim" htmlFor="typed-confirmation">
                {state.requiredTextLabel}
              </label>
              <input
                id="typed-confirmation"
                type="text"
                value={typedText}
                onChange={(event) => setTypedText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && typedText.trim() === state.requiredText) close(true);
                  if (event.key === "Escape") close(false);
                }}
                autoComplete="off"
                autoFocus
                className="font-mono"
              />
            </div>
          )}
        </div>
        <div className={isMobile ? "mt-5 flex gap-2" : "flex justify-end gap-2 border-t bg-subtle/50 px-5 py-3"}>
          <Btn onClick={() => close(false)} className={isMobile ? "flex-1" : ""}>Cancel</Btn>
          <Btn
            onClick={() => close(true)}
            variant={state.danger ? "danger" : "primary"}
            disabled={state.requiredText !== undefined && typedText.trim() !== state.requiredText}
            className={isMobile ? "flex-1" : ""}
          >
            Confirm
          </Btn>
        </div>
      </div>
    </div>
  );
}

// --- Spinner ---
export function Spinner({ className = "" }: { className?: string }) {
  return <Loader2 size={16} className={`animate-spin text-muted ${className}`} />;
}

// --- Logo ---
// The brand mark: a lime arrow on a dark tile. Used by the nav and auth pages.
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="2" y="2" width="60" height="60" rx="15" fill="#18181B" />
      <rect x="2.5" y="2.5" width="59" height="59" rx="14.5" stroke="white" strokeOpacity="0.12" />
      <path d="M32 14 46 31h-9v13H27V31h-9z" fill="#BAFF39" />
      <rect x="22" y="47" width="20" height="4.5" rx="2.25" fill="#BAFF39" />
    </svg>
  );
}

// --- Copy Button ---
export function CopyButton({ text, size = 12 }: { text: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
      title={copied ? "Copied" : "Copy"}
      className="inline-grid shrink-0 place-items-center rounded p-1 text-muted transition-colors hover:bg-subtle hover:text-fg"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={size} className="text-success" /> : <Copy size={size} />}
    </button>
  );
}

// --- Info tip ---
// Help is deliberately hidden until requested, but remains available through
// hover, keyboard focus, and tap. Keeping this here gives every form the same
// interaction and avoids permanently rendering explanatory paragraphs.
export function InfoTip({ children, text }: { children?: ReactNode; text?: ReactNode }) {
  const content = children ?? text;
  const tooltipId = useId();
  if (!content) return null;

  return (
    <span className="group relative inline-flex shrink-0 items-center">
      <button
        type="button"
        aria-label="More information"
        aria-describedby={tooltipId}
        className="inline-grid h-5 w-5 place-items-center rounded text-muted transition-colors hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-2"
      >
        <Info size={13} aria-hidden="true" />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-[80] mb-1.5 w-max max-w-[280px] -translate-x-1/2 rounded-md bg-primary px-2.5 py-1.5 text-xs font-normal normal-case tracking-normal text-primary-fg opacity-0 shadow-pop transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
      >
        {content}
      </span>
    </span>
  );
}

// --- Status Badge ---
type StatusTone = "success" | "warning" | "danger" | "neutral";

export function statusTone(status: string): StatusTone {
  const s = status?.toLowerCase() || "unknown";
  if (["running", "done", "ready", "online", "healthy", "active", "deployed", "completed", "open", "succeeded", "success", "ok"].includes(s)) return "success";
  if (["deploying", "pending", "queued", "compensating", "connecting", "disconnected", "ended", "working", "running_op", "provisioning", "starting", "stopping", "degraded", "partial", "rolling_back"].includes(s)) return "warning";
  if (["unhealthy", "error", "failed", "offline", "cancelled", "compensated", "compensation_failed"].includes(s)) return "danger";
  return "neutral";
}

const STATUS_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-muted/60",
};

export function humanize(value: string): string {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function StatusBadge({ status, subLabel }: { status: string; subLabel?: string }) {
  const s = status?.toLowerCase() || "unknown";
  const tone = statusTone(s);
  const live = s === "deploying" || s === "working";

  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-fg-dim">
      <span className="relative flex h-2 w-2 shrink-0">
        {live && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${STATUS_DOT[tone]}`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${STATUS_DOT[tone]}`} />
      </span>
      {humanize(status || "unknown")}
      {subLabel && <span className="font-normal text-muted">· {subLabel}</span>}
    </span>
  );
}

// --- Page composition ---
// The panel used to rebuild its page container and title row in every route.
// These primitives keep spacing, hierarchy, back navigation, and responsive
// action placement consistent without prescribing page-specific content.
export function PageShell({
  children,
  width = "lg",
  className = "",
}: {
  children: ReactNode;
  width?: "md" | "lg" | "xl";
  className?: string;
}) {
  const widths = { md: "max-w-3xl", lg: "max-w-5xl", xl: "max-w-6xl" };
  return (
    <main className={`${widths[width]} mx-auto animate-fade-in space-y-6 px-4 py-6 md:px-6 md:py-8 ${className}`}>
      {children}
    </main>
  );
}

export function PageHeader({
  title,
  eyebrow,
  description,
  meta,
  backHref,
  backLabel = "Back",
  actions,
  className = "",
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0">
        {(backHref || eyebrow) && (
          <div className="mb-2 flex min-w-0 items-center gap-2 text-sm text-muted">
            {backHref && (
              <a href={backHref} className="inline-flex items-center gap-1 rounded transition-colors hover:text-fg">
                <ArrowLeft size={14} />
                {backLabel}
              </a>
            )}
            {backHref && eyebrow && <span className="text-line-strong">/</span>}
            {eyebrow && <span className="truncate">{eyebrow}</span>}
          </div>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-fg-dim">{description}</p>}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div>}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}

export function PageState({
  kind = "loading",
  title,
  description,
  action,
}: {
  kind?: "loading" | "empty" | "error";
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <PageShell>
      <div role={kind === "error" ? "alert" : "status"} className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
        {kind === "loading" && <Spinner />}
        {kind === "error" && (
          <span className="grid h-10 w-10 place-items-center rounded-full bg-danger/10 text-danger"><AlertCircle size={18} /></span>
        )}
        {title && <div className={`text-sm font-medium ${kind === "loading" ? "text-muted" : "text-fg"}`}>{title}</div>}
        {description && <p className="max-w-md text-sm text-muted">{description}</p>}
        {action}
      </div>
    </PageShell>
  );
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "border-line bg-subtle text-fg-dim",
  success: "border-success/20 bg-success/10 text-success",
  warning: "border-warning/25 bg-warning/10 text-warning",
  danger: "border-danger/20 bg-danger/10 text-danger",
  info: "border-info/20 bg-info/10 text-info",
};

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return <span className={`inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-2xs font-medium ${BADGE_TONES[tone]} ${className}`}>{children}</span>;
}

export function InlineNotice({
  children,
  tone = "info",
  title,
  className = "",
}: {
  children: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  title?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: { box: "border-info/25 bg-info/5", icon: "text-info", Icon: Info },
    success: { box: "border-success/25 bg-success/5", icon: "text-success", Icon: CheckCircle2 },
    warning: { box: "border-warning/30 bg-warning/5", icon: "text-warning", Icon: AlertTriangle },
    danger: { box: "border-danger/25 bg-danger/5", icon: "text-danger", Icon: AlertCircle },
  };
  const { box, icon, Icon } = tones[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex gap-3 rounded-lg border p-3.5 ${box} ${className}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${icon}`} />
      <div className="min-w-0 flex-1">
        {title && <div className="mb-0.5 text-sm font-medium text-fg">{title}</div>}
        <div className="text-sm text-fg-dim">{children}</div>
      </div>
    </div>
  );
}

export function AuthShell({
  icon,
  title,
  description,
  children,
  width = "sm",
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  width?: "sm" | "md" | "lg";
}) {
  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg" };
  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className={`w-full ${widths[width]} animate-slide-up`}>
        <header className="mb-6 flex flex-col items-center text-center">
          <div className="mb-5"><Logo size={40} /></div>
          {icon && <div className="mb-3 flex justify-center text-muted">{icon}</div>}
          <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
        </header>
        {children}
      </div>
    </main>
  );
}

// --- Card ---
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border bg-surface shadow-xs ${className}`}>
      {children}
    </div>
  );
}

// A card's title bar. Put it first inside <Card className="overflow-hidden">;
// the body that follows owns its own padding.
export function CardHeader({
  title,
  description,
  icon,
  actions,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2.5 ${className}`}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="flex shrink-0 text-muted">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>
          {description && <p className="truncate text-xs text-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

// --- Key/value rows ---
// Read-only facts ("Image", "Port", "Created"). Stack them inside a Card; rows
// draw their own dividers.
export function DataRow({
  label,
  children,
  mono = false,
  className = "",
}: {
  label: ReactNode;
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex min-h-11 items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0 ${className}`}>
      <div className="shrink-0 text-sm text-muted">{label}</div>
      <div className={`flex min-w-0 items-center justify-end gap-1.5 text-right text-sm text-fg ${mono ? "font-mono text-xs" : ""}`}>{children}</div>
    </div>
  );
}

// --- Stat ---
export function Stat({
  label,
  value,
  hint,
  tone,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Exclude<Tone, "neutral">;
  className?: string;
}) {
  const valueTone = tone ? { success: "text-success", warning: "text-warning", danger: "text-danger", info: "text-info" }[tone] : "text-fg";
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="truncate text-xs text-muted">{label}</div>
      <div className={`mt-1 truncate text-xl font-semibold tabular-nums tracking-tight ${valueTone}`}>{value}</div>
      {hint && <div className="mt-0.5 truncate text-xs text-muted">{hint}</div>}
    </div>
  );
}

// --- Segmented control ---
export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  className = "",
  ariaLabel,
}: {
  options: readonly { value: K; label: ReactNode }[];
  value: K;
  onChange: (value: K) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={`inline-flex rounded-md border bg-subtle p-0.5 ${className}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-7 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-3 text-sm font-medium transition-colors max-md:h-9 ${
              active ? "bg-surface text-fg shadow-xs" : "text-muted hover:text-fg"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// --- Btn ---
export function Btn({
  children,
  onClick,
  type = "button",
  variant = "default",
  size = "sm",
  disabled = false,
  loading = false,
  className = "",
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const isMobile = useMobileLayout();
  const iconOnly = isIconOnly(children);
  const base = "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow] select-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1";
  const heights = isMobile
    ? { xs: "h-10", sm: "h-11", md: "h-12" }
    : { xs: "h-7", sm: "h-8", md: "h-9" };
  const pads = iconOnly
    ? (isMobile ? { xs: "w-10", sm: "w-11", md: "w-12" } : { xs: "w-7", sm: "w-8", md: "w-9" })
    : { xs: "px-2.5", sm: "px-3", md: "px-4" };
  const text = size === "xs" ? "text-xs" : "text-sm";

  const variants = {
    default: "border border-line-strong bg-surface text-fg shadow-xs hover:bg-subtle",
    primary: "border border-primary bg-primary text-primary-fg shadow-xs hover:opacity-90",
    danger: "border border-danger-solid bg-danger-solid text-white shadow-xs hover:opacity-90",
    ghost: "border border-transparent text-fg-dim hover:bg-subtle hover:text-fg",
  };

  let renderedChildren: ReactNode = children;
  let iconReplaced = false;
  if (loading) {
    const swap = replaceFirstIconWithSpinner(children);
    renderedChildren = swap.found ? swap.node : stripLeadingGlyph(children);
    iconReplaced = swap.found;
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled || loading} title={title} aria-label={ariaLabel || title} className={`${base} ${heights[size]} ${pads[size]} ${text} ${variants[variant]} ${className}`}>
      {loading && !iconReplaced && <Loader2 size={size === "xs" ? 12 : 14} className="flex-shrink-0 animate-spin" />}
      {renderedChildren}
    </button>
  );
}

// A button whose only child is an icon renders square.
function isIconOnly(node: ReactNode): boolean {
  const arr = React.Children.toArray(node);
  if (arr.length !== 1) return false;
  const only = arr[0];
  return React.isValidElement(only) && typeof (only.props as { size?: unknown }).size === "number";
}

// Text-only buttons often lead with a one-character glyph acting as the icon
// ("+ Add Passkey", "×"). While loading, that glyph is dropped so the prepended
// spinner takes its place instead of sitting next to it.
function stripLeadingGlyph(node: ReactNode): ReactNode {
  const arr = React.Children.toArray(node);
  const first = arr[0];
  if (typeof first === "string") {
    const m = first.match(/^\s*\S(\s+|$)/);
    if (m) return [first.slice(m[0].length), ...arr.slice(1)];
  }
  return node;
}

// Walk children and swap the first Lucide-style icon element (detected by a
// numeric `size` prop) for a same-size spinner, so a loading button shows a
// spinner where its icon was instead of spinning the icon itself. Returns the
// transformed tree and whether an icon was found, so Btn can prepend a spinner
// for icon-less buttons.
function replaceFirstIconWithSpinner(node: ReactNode): { node: ReactNode; found: boolean } {
  let found = false;
  const visit = (child: ReactNode): ReactNode => {
    if (found || !React.isValidElement(child)) return child;
    const props = child.props as { size?: unknown; className?: string; children?: ReactNode };
    if (typeof props.size === "number") {
      found = true;
      return <Loader2 key={child.key ?? undefined} size={props.size} className="animate-spin flex-shrink-0" />;
    }
    if (props.children !== undefined) {
      const newChildren = React.Children.map(props.children, visit);
      if (found) return React.cloneElement(child, {}, newChildren);
    }
    return child;
  };
  const result = React.Children.map(node, visit);
  return { node: result, found };
}

// --- Table ---
// Cell padding and typography live here; pages only add alignment/width classes
// to <td>. On phones each row becomes a labelled card.
export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  const isMobile = useMobileLayout();

  if (isMobile) {
    return (
      <div className="space-y-2.5">
        {React.Children.toArray(children).map((row, rowIndex) => {
          if (!React.isValidElement(row)) return row;
          const rowProps = row.props as React.HTMLAttributes<HTMLTableRowElement>;
          const cells = React.Children.toArray(rowProps.children);
          return (
            <div
              key={row.key ?? rowIndex}
              className={`rounded-lg border bg-surface px-4 py-1.5 shadow-xs ${rowProps.onClick ? "cursor-pointer active:bg-subtle" : ""}`}
              role={rowProps.onClick ? "link" : undefined}
              tabIndex={rowProps.onClick ? 0 : undefined}
              onClick={rowProps.onClick ? (event) => rowProps.onClick?.(event as unknown as React.MouseEvent<HTMLTableRowElement>) : undefined}
              onKeyDown={rowProps.onClick ? (event) => {
                if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                event.preventDefault();
                rowProps.onClick?.(event as unknown as React.MouseEvent<HTMLTableRowElement>);
              } : undefined}
            >
              {cells.map((cell, cellIndex) => {
                if (!React.isValidElement(cell)) return null;
                const cellProps = cell.props as React.TdHTMLAttributes<HTMLTableCellElement>;
                const content = cellProps.children;
                const label = headers[cellIndex] || "";
                return (
                  <div
                    key={cell.key ?? cellIndex}
                    onClick={cellProps.onClick ? (event) => cellProps.onClick?.(event as unknown as React.MouseEvent<HTMLTableCellElement>) : undefined}
                    className={`flex min-h-10 items-center gap-3 border-b py-2 last:border-b-0 ${label ? "justify-between" : "justify-end"}`}
                  >
                    {label && <span className="shrink-0 text-xs text-muted">{label}</span>}
                    <div className="min-w-0 max-w-[70%] break-words text-right text-sm text-fg">{content}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm [&_td]:px-4 [&_td]:py-2.5 [&_td]:align-middle [&_tbody_tr:hover]:bg-subtle/50 [&_tbody_tr]:transition-colors">
        <thead>
          <tr className="border-b bg-subtle/50">
            {headers.map((h, i) => (
              <th key={`${h}-${i}`} className="whitespace-nowrap px-4 py-2 text-left text-xs font-medium text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">{children}</tbody>
      </table>
    </div>
  );
}

// --- Checkbox ---
export function Checkbox({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label || "Toggle option"}
        onChange={(event) => onChange(event.target.checked)}
        className="shrink-0"
      />
      {label && <span className="text-sm text-fg">{label}</span>}
    </label>
  );
}

// --- Field ---
// A settings-style row: label (left) + control (right) on one line. The control
// column is right-bound and width-capped so inputs align down the right edge.
// Drop any control inside — inputs, NeoSelect, and textareas are all width:100%
// so they fill the column. Use `align="start"` for multi-line controls
// (textareas) and `wide` for controls that need a roomier column. Pass
// `divider` to draw a hairline rule between rows (off by default).
export function Field({
  label,
  hint,
  children,
  className = "",
  align = "center",
  wide = false,
  divider = false,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "center" | "start";
  wide?: boolean;
  divider?: boolean;
  htmlFor?: string;
}) {
  const isMobile = useMobileLayout();
  const generatedId = useId();
  const isNativeControl = React.isValidElement(children)
    && typeof children.type === "string"
    && ["input", "select", "textarea"].includes(children.type);
  const controlId = htmlFor || (isNativeControl ? generatedId : undefined);
  const renderedControl = isNativeControl
    ? React.cloneElement(children as React.ReactElement<{ id?: string }>, {
        id: (children.props as { id?: string }).id || controlId,
      })
    : children;
  const col = wide ? "w-[min(75%,34rem)]" : "w-[min(62%,20rem)]";
  const fieldLabel = label || hint ? (
    <div className="flex min-w-0 items-center gap-1">
      {label && <label htmlFor={controlId} className="block text-sm font-medium text-fg">{label}</label>}
      {hint && <InfoTip>{hint}</InfoTip>}
    </div>
  ) : null;
  if (isMobile) {
    return (
      <div className={`py-3 ${divider ? "border-b last:border-b-0" : ""} ${className}`}>
        {fieldLabel && <div className="mb-2">{fieldLabel}</div>}
        <div className="w-full">{renderedControl}</div>
      </div>
    );
  }
  return (
    <div
      className={`flex ${align === "start" ? "items-start" : "items-center"} justify-between gap-6 py-3 ${
        divider ? "border-b last:border-b-0" : ""
      } ${className}`}
    >
      {fieldLabel && <div className={`min-w-0 ${align === "start" ? "pt-1.5" : ""}`}>{fieldLabel}</div>}
      <div className={`shrink-0 ${col}`}>{renderedControl}</div>
    </div>
  );
}

// --- Divider ---
// A hairline rule for separating logical sections of a form/card.
export function Divider({ className = "" }: { className?: string }) {
  return <div className={`border-t ${className}`} />;
}

// --- Empty State ---
export function EmptyState({
  message,
  icon: Icon,
  description,
  action,
  className = "",
}: {
  message: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center px-4 py-14 text-center ${className}`}>
      {Icon && (
        <span className="mb-3 grid h-10 w-10 place-items-center rounded-lg border bg-subtle text-muted">
          <Icon size={18} />
        </span>
      )}
      <p className="text-sm font-medium text-fg">{message}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
