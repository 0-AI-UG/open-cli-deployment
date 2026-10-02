import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Cpu,
  HardDrive,
  Home,
  Layers,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Server,
  Sun,
  TerminalSquare,
  User,
  Users,
} from "lucide-react";
import { useAuth, logout } from "../stores/auth.ts";
import { setThemePreference, useThemePreference } from "../stores/theme.ts";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
import { MobileActionSheet, MobileSheetAction } from "./mobile-action-sheet.tsx";
import { SkillInstallMenu } from "./skill-install-menu.tsx";
import { Logo, SegmentedControl } from "./ui.tsx";

const navItems = [
  { hash: "#/", label: "Overview", icon: Server, match: /^#\/?$|^#\/(apps|stacks)\// },
  { hash: "#/environments", label: "Environments", icon: Layers, match: /^#\/environments/ },
  { hash: "#/resources", label: "Resources", icon: HardDrive, match: /^#\/resources/ },
  { hash: "#/incidents", label: "Incidents", icon: AlertTriangle, match: /^#\/incidents/ },
  { hash: "#/engine", label: "Operations", icon: Cpu, match: /^#\/engine/ },
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
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-fg-dim transition-colors hover:bg-subtle hover:text-fg"
      title={installCmd}
    >
      {copied ? <Check size={14} className="text-success" /> : <TerminalSquare size={14} />}
      {copied ? "Copied" : "Install CLI"}
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
        className={`inline-flex h-8 items-center gap-2 rounded-md pl-1 pr-2 text-sm font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
      >
        {user?.githubAvatarUrl
          ? <img src={user.githubAvatarUrl} alt="" className="h-6 w-6 rounded-full border" />
          : <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-2xs font-semibold text-primary-fg">{initial}</span>}
        <span className="max-w-32 truncate text-fg">{user?.username}</span>
        <ChevronDown size={14} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-full z-[60] mt-1.5 w-60 animate-pop-in rounded-lg border bg-surface p-1 shadow-pop">
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="truncate text-sm font-medium text-fg">{user?.username}</div>
            <div className="text-xs text-muted">{user?.isAdmin ? "Administrator" : "Member"}</div>
          </div>
          <div className="my-1 border-t" />
          <a href="#/account" role="menuitem" className={itemClass}><User size={15} /> Account</a>
          {user?.isAdmin && <a href="#/admin" role="menuitem" className={itemClass}><Users size={15} /> Admin</a>}
          <div className="my-1 border-t" />
          <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
            <span className="text-sm text-fg-dim">Theme</span>
            <SegmentedControl ariaLabel="Theme" options={themeOptions} value={theme} onChange={setThemePreference} />
          </div>
          <div className="my-1 border-t" />
          <button role="menuitem" onClick={logoutAndRedirect} className={itemClass}><LogOut size={15} /> Log out</button>
        </div>
      )}
    </div>
  );
}

function DesktopNav({ hash }: { hash: string }) {
  const { user } = useAuth();
  const items = user?.isAdmin
    ? [...navItems, { hash: "#/admin", label: "Admin", icon: Users, match: /^#\/admin/ }]
    : navItems;

  return (
    <header className="sticky top-0 z-50 border-b bg-surface/85 backdrop-blur-md supports-[backdrop-filter]:bg-surface/75">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-6">
          <a href="#/" className="flex shrink-0 items-center gap-2 rounded-md text-fg" aria-label="OCD overview">
            <Logo size={24} />
            <span className="text-base font-semibold tracking-tight">OCD</span>
          </a>
          <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto" aria-label="Primary navigation">
            {items.map((item) => {
              const active = item.match.test(hash);
              return (
                <a
                  key={item.hash}
                  href={item.hash}
                  aria-current={active ? "page" : undefined}
                  className={`relative inline-flex h-8 shrink-0 items-center rounded-md px-3 text-sm font-medium transition-colors ${
                    active ? "bg-subtle text-fg" : "text-muted hover:text-fg"
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CliCopyButton />
          <SkillInstallMenu />
          <div className="mx-1.5 h-5 w-px bg-line" />
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

  const primaryItems = [
    { hash: "#/", label: "Home", icon: Home, active: /^#\/?$/.test(hash) || /^#\/(apps|stacks)\//.test(hash) },
    { hash: "#/resources", label: "Resources", icon: HardDrive, active: hash.startsWith("#/resources") },
    { hash: "#/incidents", label: "Incidents", icon: AlertTriangle, active: hash.startsWith("#/incidents") },
  ];
  const moreActive = moreOpen || ["#/environments", "#/engine", "#/admin", "#/account"].some((prefix) => hash.startsWith(prefix));

  return (
    <>
      <header className="sticky top-0 z-50 border-b bg-surface/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="flex h-[52px] items-center justify-between px-4">
          <a href="#/" className="flex h-11 items-center gap-2 font-semibold tracking-tight text-fg" aria-label="OCD overview">
            <Logo size={26} />
            <span className="text-base">OCD</span>
          </a>
          <button onClick={() => setMoreOpen(true)} className="flex h-11 max-w-[55%] items-center gap-2 pl-2 text-sm font-medium text-fg-dim" aria-label="Open account and navigation menu">
            <span className="truncate">{user?.username}</span>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-fg">
              {(user?.username || "?").charAt(0).toUpperCase()}
            </span>
          </button>
        </div>
      </header>

      <nav className="fixed inset-x-0 bottom-0 z-50 border-t bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md" aria-label="Primary navigation">
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
        <MobileSheetAction icon={<Cpu size={19} />} label="Operations" detail="Progress, logs, and recovery actions" onClick={() => { window.location.hash = "#/engine"; }} />
        {user?.isAdmin && <MobileSheetAction icon={<Users size={19} />} label="Admin" detail="Setup, integrations, and users" onClick={() => { window.location.hash = "#/admin"; }} />}
        <MobileSheetAction icon={<User size={19} />} label="Account" detail="Security and profile" onClick={() => { window.location.hash = "#/account"; }} />
        <MobileSheetAction icon={copied ? <Check size={19} /> : <TerminalSquare size={19} />} label={copied ? "Copied install command" : "Copy CLI install command"} onClick={copy} />
        <div className="flex items-center justify-between rounded-lg border bg-surface px-4 py-2.5">
          <span className="text-sm font-medium">Agent skill</span>
          <SkillInstallMenu />
        </div>
        <div className="flex items-center justify-between rounded-lg border bg-surface px-4 py-2.5">
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
