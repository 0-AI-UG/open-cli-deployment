import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Check,
  HardDrive,
  Home,
  Layers,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Settings,
  Sun,
  TerminalSquare,
  User,
} from "lucide-react";
import { useAuth, logout } from "../stores/auth.ts";
import { setThemePreference, useResolvedTheme, useThemePreference } from "../stores/theme.ts";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
import { MobileActionSheet, MobileSheetAction } from "./mobile-action-sheet.tsx";
import { SkillInstallMenu } from "./skill-install-menu.tsx";
import { DesktopMenuNav } from "./nav-menu.tsx";
import { Logo, SegmentedControl } from "./ui.tsx";

const navItems = [
  { hash: "#/", label: "Apps", icon: Home, match: /^#\/?$|^#\/(apps|stacks)/ },
  { hash: "#/engine", label: "Activity", icon: Activity, match: /^#\/(engine|incidents)/ },
  { hash: "#/resources", label: "Infrastructure", icon: HardDrive, match: /^#\/resources/ },
];
const themeOptions = [
  { value: "system", label: <Monitor size={14} aria-label="System" /> },
  { value: "light", label: <Sun size={14} aria-label="Light" /> },
  { value: "dark", label: <Moon size={14} aria-label="Dark" /> },
] as const;

function useInstallCommandCopy() {
  const [copied, setCopied] = useState(false);
  const installCmd = `curl -fsSL ${window.location.origin}/cli/install.sh | sh`;
  const copy = () => {
    navigator.clipboard.writeText(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy, installCmd };
}

function CliCopyButton() {
  const { copied, copy, installCmd } = useInstallCommandCopy();
  return (
    <button
      onClick={copy}
      className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-surface px-3 text-sm font-medium text-fg transition-colors hover:border-frame"
      title={installCmd}
    >
      {copied ? <Check size={14} className="text-success" /> : <TerminalSquare size={14} />}
      {copied ? "Copied" : "CLI"}
    </button>
  );
}

// One-click light/dark switch in the header. It pins an explicit theme; the
// user menu still offers "System" to follow the OS again.
function ThemeToggle() {
  const resolved = useResolvedTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setThemePreference(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line-strong bg-surface text-fg transition-colors hover:border-frame"
    >
      {resolved === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function logoutAndRedirect() {
  logout();
  window.location.hash = "#/login";
}

function UserMenu({ hash }: { hash: string }) {
  const { user } = useAuth();
  const theme = useThemePreference();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [hash]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const initial = (user?.username || "?").charAt(0).toUpperCase();
  const itemClass = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-fg-dim transition-colors hover:bg-subtle hover:text-fg";

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user?.username ?? "user"}`}
        title={user?.username}
        className={`grid h-8 w-8 place-items-center rounded-full border bg-surface p-0.5 transition-colors hover:border-frame ${open ? "border-frame" : "border-line-strong"}`}
      >
        <span className="grid h-full w-full place-items-center rounded-full bg-primary text-2xs font-semibold text-primary-fg">{initial}</span>
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-[60] mt-1.5 w-64 animate-pop-in rounded-lg bg-canvas/95 p-1.5 shadow-pop backdrop-blur-md">
          <div className="border border-line bg-surface p-1">
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="truncate text-sm font-medium text-fg">{user?.username}</div>
          </div>
          <div className="my-1 border-t" />
          <a href="#/account" role="menuitem" className={itemClass}><User size={15} /> Account</a>
          <div className="my-1 border-t" />
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="text-sm text-fg-dim">Theme</span>
            <SegmentedControl ariaLabel="Theme" options={themeOptions} value={theme} onChange={setThemePreference} />
          </div>
          <div className="my-1 border-t" />
          <button role="menuitem" onClick={logoutAndRedirect} className={itemClass}><LogOut size={15} /> Log out</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DesktopNav({ hash }: { hash: string }) {
  return (
    <header className="rule-dashed sticky top-0 z-50 bg-canvas/90 backdrop-blur-md">
      <div className="grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6">
        <a href="#/" className="flex h-10 shrink-0 items-center gap-2 justify-self-start rounded-md text-fg" aria-label="OCD overview">
          <span className="text-brand"><Logo size={28} mono /></span>
        </a>
        <DesktopMenuNav hash={hash} />
        <div className="flex shrink-0 items-center gap-1 justify-self-end">
          <CliCopyButton />
          <SkillInstallMenu />
          <ThemeToggle />
          <UserMenu hash={hash} />
        </div>
      </div>
    </header>
  );
}

function MobileNav({ hash }: { hash: string }) {
  const { user } = useAuth();
  const theme = useThemePreference();
  const [moreOpen, setMoreOpen] = useState(false);
  const { copied, copy } = useInstallCommandCopy();
  useEffect(() => setMoreOpen(false), [hash]);

  const primaryItems = navItems.map((item) => ({ ...item, label: item.hash === "#/resources" ? "Infra" : item.label, active: item.match.test(hash) }));
  const moreActive = moreOpen || ["#/environments", "#/settings", "#/account"].some((prefix) => hash.startsWith(prefix));

  return (
    <>
      <header className="rule-dashed sticky top-0 z-50 bg-canvas/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="flex h-[52px] items-center justify-between px-4">
          <a href="#/" className="flex h-11 items-center gap-2 font-semibold tracking-tight text-fg" aria-label="OCD overview">
            <span className="text-brand"><Logo size={26} mono /></span>
          </a>
          <div className="flex min-w-0 max-w-[65%] items-center gap-1">
          <ThemeToggle />
          <button onClick={() => setMoreOpen(true)} className="flex h-11 min-w-0 items-center gap-2 pl-2 text-sm font-medium text-fg-dim" aria-label="Open account and navigation menu">
            <span className="truncate">{user?.username}</span>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-fg">
              {(user?.username || "?").charAt(0).toUpperCase()}
            </span>
          </button>
          </div>
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t bg-canvas/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md" aria-label="Primary navigation">
        <div className="grid h-[60px] grid-cols-4">
          {primaryItems.map((item) => {
            const Icon = item.icon;
            return (
              <a key={item.hash} href={item.hash} className={`flex min-w-0 flex-col items-center justify-center gap-1 text-2xs font-medium ${item.active ? "text-fg" : "text-muted"}`} aria-current={item.active ? "page" : undefined}>
                <Icon size={21} strokeWidth={item.active ? 2.25 : 1.75} />
                <span>{item.label}</span>
              </a>
            );
          })}
          <button onClick={() => setMoreOpen(true)} className={`flex flex-col items-center justify-center gap-1 text-2xs font-medium ${moreActive ? "text-fg" : "text-muted"}`}>
            <Menu size={21} strokeWidth={moreActive ? 2.25 : 1.75} /><span>More</span>
          </button>
        </div>
      </nav>

      <MobileActionSheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Menu" subtitle={user?.username}>
        <MobileSheetAction icon={<Layers size={19} />} label="Environments" detail="Variables, secrets, and rollout behavior" onClick={() => { window.location.hash = "#/environments"; }} />
        <MobileSheetAction icon={<Settings size={19} />} label="Settings" detail="Hetzner, build, panel, and users" onClick={() => { window.location.hash = "#/settings"; }} />
        <MobileSheetAction icon={<User size={19} />} label="Account" detail="Security and profile" onClick={() => { window.location.hash = "#/account"; }} />
        <MobileSheetAction icon={copied ? <Check size={19} /> : <TerminalSquare size={19} />} label={copied ? "Copied install command" : "Copy CLI install command"} onClick={copy} />
        <div className="frame flex items-center justify-between bg-surface px-4 py-2.5">
          <span className="text-sm font-medium">Agent skill</span>
          <SkillInstallMenu />
        </div>
        <div className="frame flex items-center justify-between bg-surface px-4 py-2.5">
          <span className="text-sm font-medium">Theme</span>
          <SegmentedControl ariaLabel="Theme" options={themeOptions} value={theme} onChange={setThemePreference} />
        </div>
        <MobileSheetAction icon={<LogOut size={19} />} label="Log out" danger onClick={logoutAndRedirect} />
      </MobileActionSheet>
    </>
  );
}

export function Nav() {
  const hash = window.location.hash || "#/";
  const isMobile = useMobileLayout();
  return isMobile ? <MobileNav hash={hash} /> : <DesktopNav hash={hash} />;
}
