import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  Boxes,
  CheckCircle2,
  ChevronsUpDown,
  Gauge,
  HardDrive,
  History,
  PanelsTopLeft,
  Server,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { HetznerIcon, type BrandIcon } from "./brand-icons";

// Desktop header navigation, built like Cloudflare's: plain links and menu
// triggers in a centered row, and one shared panel under the header. Moving
// between triggers keeps the panel open and morphs it: its size animates to
// the next menu and the content slides in from the side you moved toward.

type MenuLink = { label: string; description: string; href: string; icon?: LucideIcon | BrandIcon };
type MenuColumn = { title?: string; links: MenuLink[] };
type Menu = {
  key: string;
  label: string;
  match: RegExp;
  // Plain links have no panel.
  href?: string;
  width?: number;
  columns?: MenuColumn[];
  footer?: { label: string; href: string };
  related?: { label: string; href: string }[];
};

const MENUS: Menu[] = [
  { key: "overview", label: "Overview", href: "#/", match: /^#\/?$|^#\/(apps|stacks)\// },
  { key: "environments", label: "Environments", href: "#/environments", match: /^#\/environments/ },
  {
    key: "resources",
    label: "Infrastructure",
    match: /^#\/resources/,
    width: 700,
    columns: [
      { title: "Compute", links: [
        { label: "Servers", description: "Hetzner machines, load and pricing", href: "#/resources" },
      ] },
      { title: "Storage", links: [
        { label: "Volumes", description: "Persistent disks attached to apps", href: "#/resources?section=volumes" },
        { label: "Object storage", description: "S3 buckets for files and backups", href: "#/resources?section=object-storage" },
      ] },
    ],
    footer: { label: "All infrastructure", href: "#/resources" },
    related: [{ label: "Environments", href: "#/environments" }, { label: "Activity", href: "#/engine" }],
  },
  {
    key: "activity",
    label: "Activity",
    match: /^#\/(engine|incidents)/,
    width: 760,
    columns: [
      { title: "Operations", links: [
        { label: "All operations", description: "Running, pending and recent engine work", href: "#/engine", icon: Activity },
        { label: "Needs review", description: "Finished, but something should be checked", href: "#/engine?filter=needs_attention", icon: Gauge },
        { label: "Failures", description: "Operations that failed or were compensated", href: "#/engine?filter=failures", icon: XCircle },
        { label: "Cancelled", description: "Stopped before they finished", href: "#/engine?filter=cancelled", icon: Ban },
      ] },
      { title: "Incidents", links: [
        { label: "Active", description: "Conditions that need attention now", href: "#/incidents", icon: AlertTriangle },
        { label: "Resolved", description: "Recovered incidents and how they ended", href: "#/incidents?status=resolved", icon: CheckCircle2 },
        { label: "All incidents", description: "The full history, newest first", href: "#/incidents?status=all", icon: History },
      ] },
    ],
    footer: { label: "Open activity", href: "#/engine" },
  },
  {
    key: "settings",
    label: "Settings",
    match: /^#\/settings/,
    width: 760,
    columns: [
      { links: [
        { label: "Hetzner and domain", description: "API token, Object Storage and app domain", href: "#/settings", icon: HetznerIcon },
        { label: "Build", description: "Git connections, registries and workers", href: "#/settings?section=build", icon: Boxes },
      ] },
      { links: [
        { label: "Panel", description: "The self-hosted panel and its updates", href: "#/settings?section=panel", icon: PanelsTopLeft },
        { label: "Users", description: "Accounts, invites and 2FA", href: "#/settings?section=users", icon: ShieldCheck },
      ] },
    ],
    footer: { label: "Open settings", href: "#/settings" },
    related: [{ label: "Account", href: "#/account" }],
  },
];

// Icons for the column headings of a list-style menu, so the plain list still
// scans like the icon menus next to it.
const COLUMN_ICONS: Record<string, LucideIcon> = { Compute: Server, Storage: HardDrive, Operations: Activity, Incidents: AlertTriangle };

const CLOSE_DELAY = 160;

export function DesktopMenuNav({ hash }: { hash: string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The panel keeps showing the last menu while it fades out.
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [direction, setDirection] = useState<"left" | "right" | "none">("none");
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [animateSize, setAnimateSize] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const open = (key: string) => {
    window.clearTimeout(closeTimer.current);
    if (openKey === key) return;
    if (openKey) {
      // Switching menus: morph the open panel toward the new one.
      const from = MENUS.findIndex((menu) => menu.key === openKey);
      const to = MENUS.findIndex((menu) => menu.key === key);
      setDirection(to > from ? "right" : "left");
      setAnimateSize(true);
    } else {
      // Opening fresh: take the new size at once and fade in.
      setDirection("none");
      setAnimateSize(false);
    }
    setOpenKey(key);
    setShownKey(key);
  };
  const close = () => {
    window.clearTimeout(closeTimer.current);
    setOpenKey(null);
  };
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpenKey(null), CLOSE_DELAY);
  };
  const cancelClose = () => window.clearTimeout(closeTimer.current);

  // Size the panel to the menu it shows, before paint, so a switch animates
  // from the old size to the new one (see animateSize in open()).
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || !shownKey) return;
    const measure = () => setSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shownKey]);

  useEffect(() => {
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);

  useEffect(() => {
    if (!openKey) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = rootRef.current?.querySelector<HTMLAnchorElement>(`[data-menu-trigger="${openKey}"]`);
      close();
      trigger?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openKey]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const onTriggerEnter = (key: string) => (event: PointerEvent) => {
    if (event.pointerType === "mouse") open(key);
  };
  const onTriggerKeyDown = (key: string) => (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    open(key);
    requestAnimationFrame(() => contentRef.current?.querySelector<HTMLAnchorElement>("a")?.focus());
  };

  const shown = MENUS.find((menu) => menu.key === shownKey);
  const isOpen = openKey !== null;

  return (
    <div
      ref={rootRef}
      className="contents"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <nav className="flex min-w-0 items-center gap-0.5" aria-label="Primary navigation" onPointerLeave={scheduleClose} onPointerEnter={cancelClose}>
        {MENUS.map((menu) => {
          const active = menu.match.test(hash);
          const expanded = openKey === menu.key;
          const base = "inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3.5 text-sm font-medium transition-[color,background-color,box-shadow] duration-150";
          const tone = active
            ? "nav-pill-active text-fg"
            : expanded
              ? "bg-surface/60 text-fg ring-1 ring-inset ring-line-strong"
              : "text-muted hover:text-fg";

          if (menu.href) {
            return (
              <a
                key={menu.key}
                href={menu.href}
                aria-current={active ? "page" : undefined}
                onPointerEnter={(event) => { if (event.pointerType === "mouse") close(); }}
                className={`${base} ${tone}`}
              >
                {menu.label}
              </a>
            );
          }
          return (
            // Triggers are links to the section's page: hover (or ↓) opens the
            // menu, a click goes straight to the page.
            <a
              key={menu.key}
              href={menu.footer?.href}
              data-menu-trigger={menu.key}
              aria-haspopup="true"
              aria-expanded={expanded}
              aria-controls="header-menu-panel"
              aria-current={active ? "page" : undefined}
              onPointerEnter={onTriggerEnter(menu.key)}
              onClick={close}
              onKeyDown={onTriggerKeyDown(menu.key)}
              className={`${base} pr-2.5 ${tone}`}
            >
              {menu.label}
              <ChevronsUpDown size={13} className={`transition-colors ${expanded ? "text-fg" : "text-muted"}`} aria-hidden="true" />
            </a>
          );
        })}
      </nav>

      <div
        id="header-menu-panel"
        data-open={isOpen}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        data-morph={animateSize}
        className="menu-panel absolute left-1/2 top-full z-[60] mt-1.5 rounded-lg border border-line-strong bg-canvas/95 p-1.5 shadow-[0_18px_48px_-16px_rgb(0_0_0/0.28)] backdrop-blur-md"
        style={size ? { width: size.width + 14, height: size.height + 14 } : undefined}
      >
        <div className="menu-clip" style={size ? { width: size.width, height: size.height } : undefined}>
          {shown && (
            <div ref={contentRef} key={shown.key} data-dir={direction} className="menu-content" style={{ width: `min(${shown.width}px, calc(100vw - 46px))` }}>
              <MenuContent menu={shown} onNavigate={close} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuContent({ menu, onNavigate }: { menu: Menu; onNavigate: () => void }) {
  const columns = menu.columns ?? [];
  const currentHash = window.location.hash || "#/";

  return (
    <div className="border border-line bg-surface">
      <div className="grid divide-x divide-dashed divide-line-strong" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((column, index) => {
          const ColumnIcon = column.title ? COLUMN_ICONS[column.title] : undefined;
          return (
            <div key={column.title ?? index} className="flex flex-col gap-1 p-3">
              {column.title && (
                <div className="mb-1 flex items-center gap-1.5 px-2.5 pt-1 text-xs font-medium text-muted">
                  {ColumnIcon && <ColumnIcon size={13} aria-hidden="true" />}
                  {column.title}
                </div>
              )}
              {column.links.map((link) => {
                const Icon = link.icon;
                const current = currentHash === link.href;
                return (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={onNavigate}
                    aria-current={current ? "page" : undefined}
                    className={`group flex gap-3 rounded-md px-2.5 py-2.5 transition-colors hover:bg-subtle focus-visible:bg-subtle ${current ? "bg-subtle" : ""}`}
                  >
                    {Icon && <Icon size={17} strokeWidth={1.75} className="mt-0.5 shrink-0 text-muted transition-colors group-hover:text-fg" aria-hidden="true" />}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                        {link.label}
                        {current && <span className="h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-frame/40" aria-hidden="true" />}
                      </span>
                      <span className="mt-0.5 block text-sm text-muted">{link.description}</span>
                    </span>
                  </a>
                );
              })}
            </div>
          );
        })}
      </div>
      {(menu.footer || menu.related?.length) && (
        <div className="flex items-center justify-between gap-6 border-t border-dashed border-line-strong bg-canvas/60 px-5 py-3 text-sm">
          {menu.footer ? (
            <a href={menu.footer.href} onClick={onNavigate} className="group inline-flex items-center gap-1.5 font-medium text-fg">
              <span className="underline decoration-primary decoration-2 underline-offset-4">{menu.footer.label}</span>
              <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </a>
          ) : <span />}
          {menu.related?.length ? (
            <div className="flex items-center gap-5">
              {menu.related.map((item) => (
                <a key={item.href} href={item.href} onClick={onNavigate} className="text-muted transition-colors hover:text-fg">{item.label}</a>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
