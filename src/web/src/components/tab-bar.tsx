import { useEffect, useRef } from "react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";

export function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: readonly { key: K; label: string }[];
  active: K;
  onChange: (key: K) => void;
}) {
  const isMobile = useMobileLayout();
  const activeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const currentIndex = tabs.findIndex((tab) => tab.key === active);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    onChange(tabs[nextIndex].key);
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[nextIndex]?.focus();
    });
  };

  useEffect(() => {
    if (isMobile) activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [active, isMobile]);

  if (isMobile) {
    return (
      <div className="sticky top-[calc(52px+env(safe-area-inset-top))] z-30 -mx-4 mb-4 border-b bg-canvas/90 px-4 py-2 backdrop-blur-md">
        <div ref={listRef} onKeyDown={onKeyDown} className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Page sections">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              ref={active === tab.key ? activeRef : undefined}
              onClick={() => onChange(tab.key)}
              role="tab"
              aria-selected={active === tab.key}
              tabIndex={active === tab.key ? 0 : -1}
              className={`h-9 shrink-0 rounded-full px-4 text-sm font-medium transition-colors ${
                active === tab.key ? "bg-primary text-primary-fg" : "bg-subtle text-fg-dim"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div ref={listRef} onKeyDown={onKeyDown} className="mb-6 flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="Page sections">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          role="tab"
          aria-selected={active === t.key}
          tabIndex={active === t.key ? 0 : -1}
          className={`relative -mb-px shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors ${
            active === t.key
              ? "border-primary text-fg"
              : "border-transparent text-muted hover:text-fg"
          }`}
        >{t.label}</button>
      ))}
    </div>
  );
}
