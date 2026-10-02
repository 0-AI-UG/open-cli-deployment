import { useEffect, useRef } from "react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
import { useActiveIndicator } from "../hooks/use-active-indicator.ts";

// Joins the page header's section in PageShell rather than starting its own.
TabBar.joinsHeader = true;

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
  const { containerRef: listRef, indicatorStyle } = useActiveIndicator<HTMLDivElement>(active);

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
    const list = event.currentTarget;
    requestAnimationFrame(() => {
      const buttons = list.querySelectorAll<HTMLButtonElement>('[role="tab"]');
      buttons?.[nextIndex]?.focus();
    });
  };

  useEffect(() => {
    if (isMobile) activeRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [active, isMobile]);

  if (isMobile) {
    return (
      <div className="sticky top-[calc(52px+env(safe-area-inset-top))] z-30 -mx-4 mb-4 border-b bg-canvas/90 px-4 py-2 backdrop-blur-md">
        <div ref={listRef} onKeyDown={onKeyDown} className="relative flex gap-2 overflow-x-auto" role="tablist" aria-label="Page sections">
          <span aria-hidden="true" className="rounded-full bg-primary" style={indicatorStyle} />
          {tabs.map((tab) => (
            <button
              key={tab.key}
              ref={active === tab.key ? activeRef : undefined}
              onClick={() => onChange(tab.key)}
              role="tab"
              aria-selected={active === tab.key}
              data-active={active === tab.key}
              tabIndex={active === tab.key ? 0 : -1}
              className={`relative h-9 shrink-0 rounded-full px-4 text-sm font-medium transition-colors duration-200 ${
                active === tab.key ? "text-primary-fg" : "bg-subtle text-fg-dim"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // PageShell places the tab bar at the bottom of the page-header band. The
  // active tab is a filled pill that slides between tabs; the side padding
  // lines the first label up with the page title.
  return (
    <div ref={listRef} onKeyDown={onKeyDown} className="no-scrollbar relative flex gap-1 overflow-x-auto pb-4 md:px-2" role="tablist" aria-label="Page sections">
      <span aria-hidden="true" className="rounded-full bg-subtle" style={indicatorStyle} />
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          role="tab"
          aria-selected={active === t.key}
          data-active={active === t.key}
          tabIndex={active === t.key ? 0 : -1}
          className={`relative inline-flex h-9 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-colors duration-200 ${
            active === t.key ? "text-fg" : "text-muted hover:text-fg"
          }`}
        >{t.label}</button>
      ))}
    </div>
  );
}
