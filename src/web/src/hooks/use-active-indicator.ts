import { useEffect, useLayoutEffect, useState, type CSSProperties } from "react";

// A highlight that slides to the active item of a tab strip or segmented
// control. Mark the active child with data-active="true", make the container
// `relative`, and render one absolutely positioned element with the returned
// style behind the items (items need `relative` to stay on top). The first
// position applies instantly so the highlight never slides in from the corner.
// The container is tracked as state (a callback ref) so a strip that mounts
// after the first render, e.g. once a page's data loads, still gets measured.
export function useActiveIndicator<T extends HTMLElement>(active: unknown, mode: "fill" | "underline" = "fill") {
  const [container, containerRef] = useState<T | null>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => {
      const el = container.querySelector<HTMLElement>(':scope > [data-active="true"]');
      setRect(el ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } : null);
    };
    measure();
    // Item widths change with fonts loading and live counts, so follow them.
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [container, active, mode]);

  useEffect(() => {
    if (!rect || animate) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [rect, animate]);

  const ease = "320ms cubic-bezier(0.16, 1, 0.3, 1)";
  const indicatorStyle: CSSProperties = rect
    ? {
        position: "absolute",
        left: 0,
        top: mode === "fill" ? 0 : undefined,
        bottom: mode === "underline" ? 0 : undefined,
        width: rect.width,
        height: mode === "fill" ? rect.height : undefined,
        transform: `translate(${rect.left}px, ${mode === "fill" ? rect.top : 0}px)`,
        transition: animate ? `transform ${ease}, width ${ease}, height ${ease}` : "none",
        pointerEvents: "none",
      }
    : { display: "none" };

  return { containerRef, indicatorStyle };
}
