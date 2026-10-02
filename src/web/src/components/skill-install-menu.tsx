import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, Sparkles } from "lucide-react";
import { SKILL_AGENT_TARGETS } from "../../../shared/skill-agents.ts";
import { portalAnchorRect } from "./ui.tsx";

const MENU_WIDTH = 248;

export function SkillInstallMenu() {
  const [open, setOpen] = useState(false);
  const [copiedAgent, setCopiedAgent] = useState<string | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = portalAnchorRect(triggerRef.current);
      const left = Math.max(
        8,
        Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8),
      );
      setPosition({ top: rect.bottom + 6, left });
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
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
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

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const copyInstallCommand = async (agent: string) => {
    const command = `ocd skill install --agent ${agent}`;
    await navigator.clipboard.writeText(command);
    setCopiedAgent(agent);
    setOpen(false);

    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopiedAgent(null);
      copiedTimerRef.current = null;
    }, 2000);
  };

  const copiedTarget = SKILL_AGENT_TARGETS.find(
    (agent) => agent.name === copiedAgent,
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors ${
          open
            ? "bg-subtle text-fg"
            : "text-fg-dim hover:bg-subtle hover:text-fg"
        }`}
        title={
          copiedTarget
            ? `Copied install command for ${copiedTarget.label}`
            : "Install the OCD skill for your coding agent"
        }
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {copiedAgent ? (
          <Check size={14} className="text-success" />
        ) : (
          <Sparkles size={14} />
        )}
        <span>{copiedAgent ? "Copied" : "Agent skill"}</span>
        {!copiedAgent && (
          <ChevronDown
            size={14}
            className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            data-skill-install-menu
            role="menu"
            aria-label="Install OCD skill"
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: MENU_WIDTH,
            }}
            className="z-[90] animate-pop-in overflow-hidden rounded-lg border bg-surface shadow-pop"
          >
            <div className="border-b px-3 py-2.5">
              <div className="text-sm font-semibold text-fg">
                Install agent skill
              </div>
              <div className="mt-0.5 text-xs text-muted">
                Choose an agent to copy its command
              </div>
            </div>
            <div className="p-1">
              {SKILL_AGENT_TARGETS.map((agent) => {
                const command = `ocd skill install --agent ${agent.name}`;
                return (
                  <button
                    key={agent.name}
                    type="button"
                    role="menuitem"
                    onClick={() => void copyInstallCommand(agent.name)}
                    title={command}
                    className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-subtle focus:bg-subtle focus:outline-none"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-subtle text-muted">
                      <Sparkles size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {agent.label}
                      </span>
                      <span className="block font-mono text-2xs text-muted">
                        --agent {agent.name}
                      </span>
                    </span>
                    <Copy
                      size={14}
                      className="shrink-0 text-muted transition-colors group-hover:text-fg"
                    />
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
