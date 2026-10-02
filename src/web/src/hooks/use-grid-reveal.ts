import { useLayoutEffect, type RefObject } from "react";

// Page entrance. The grid draws itself from the top of the page down: the
// rails and the content panel's sides grow downward at a constant speed, and
// each section divider runs out to the right as the rails reach it. While the
// grid is still growing around a section, the section shows a skeleton of its
// own content (bars traced from its real text, controls and icons, so the
// skeleton has the page's actual shape). Once the grid has closed around the
// section, the skeleton fades into the content. The grid styles live under
// .page-wrap[data-grow] in global.css.
//
// A page that is still loading data renders a skeleton shell first and the
// real shell after. Both share one clock per route, so the grid keeps growing
// across that swap instead of starting over.

// Time for the grid to grow one viewport height. The whole entrance settles
// within this plus FADE_MS.
const GROW_MS = 160;
const FADE_MS = 140;
const BAR_FADE_MS = 90;
const MAX_BARS = 300;
// Traced as solid blocks; text inside them is not traced separately.
const BOX = "button, input, select, textarea, img, svg, [role='switch']";

export type RevealMode = "content" | "skeleton" | "off";

let clock: { key: string; start: number; speed: number } | null = null;

function routeKey() {
  return (window.location.hash || "#/").split("?")[0];
}

function visible(el: Element) {
  return el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
}

type Bar = { rect: DOMRect; kind: "text" | "box" | "icon" };

function traceBars(root: Element, vh: number, out: Bar[]) {
  const onScreen = (r: DOMRect) => r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.top < vh;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node && out.length < MAX_BARS; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest(`${BOX}, [aria-hidden="true"], .sr-only`) || !visible(parent)) continue;
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (onScreen(rect)) out.push({ rect, kind: "text" });
    }
  }
  for (const el of Array.from(root.querySelectorAll(BOX))) {
    if (out.length >= MAX_BARS) break;
    if (el.parentElement?.closest(`${BOX}, [aria-hidden="true"]`) || !visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (onScreen(rect)) out.push({ rect, kind: el.tagName === "svg" ? "icon" : "box" });
  }
}

export function useGridReveal(ref: RefObject<HTMLElement | null>, mode: RevealMode = "content") {
  useLayoutEffect(() => {
    const wrap = ref.current;
    if (mode === "off" || !wrap) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const now = performance.now();
    const vh = window.innerHeight;
    const key = routeKey();
    if (!clock || clock.key !== key) clock = { key, start: now, speed: vh / GROW_MS };
    const { start, speed } = clock;
    const elapsed = now - start;
    const wrapRect = wrap.getBoundingClientRect();
    // Milliseconds from now until the growing grid reaches viewport y.
    const reach = (y: number) => (y - wrapRect.top) / speed - elapsed;

    // --- Grid ---
    let gridEnd = 0;
    const grow = (el: HTMLElement, rect: DOMRect) => {
      const at = reach(rect.top);
      const ms = rect.height / speed;
      el.style.setProperty("--grow-at", `${at}ms`);
      el.style.setProperty("--grow-ms", `${ms}ms`);
      gridEnd = Math.max(gridEnd, at + ms);
    };
    grow(wrap, wrapRect);
    for (const el of Array.from(wrap.querySelectorAll<HTMLElement>(".page-rails, .zone-panel, .hero-sheet, .section-divider"))) {
      grow(el, el.getBoundingClientRect());
    }
    wrap.dataset.grow = "";

    // --- Sections ---
    const main = wrap.querySelector(":scope > main");
    const sections: Array<{ el: Element; content: Element[]; flare: boolean }> = [];
    for (const section of Array.from(wrap.querySelectorAll(":scope > section"))) {
      const sheet = section.querySelector(".hero-sheet");
      sections.push({ el: section, content: Array.from((sheet ?? section).children), flare: !!sheet });
    }
    for (const child of main ? Array.from(main.children) : []) {
      if (child.getAttribute("aria-hidden") === "true" || !child.children.length) continue;
      sections.push({ el: child, content: Array.from(child.children), flare: false });
    }

    const animations: Animation[] = [];
    const layer = document.createElement("div");
    layer.className = "grid-skeleton-layer";
    layer.setAttribute("aria-hidden", "true");
    let revealEnd = 0;

    for (const section of sections) {
      const rect = section.el.getBoundingClientRect();
      if (!rect.height || rect.top >= vh) continue;

      if (mode === "skeleton") {
        // The loading shell is already a skeleton: its bars appear as the grid reaches them.
        for (const bar of Array.from(section.el.querySelectorAll(".skeleton"))) {
          animations.push(bar.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: BAR_FADE_MS, delay: reach(bar.getBoundingClientRect().top), fill: "backwards",
          }));
        }
        continue;
      }

      // The section is done once the grid has grown past its bottom edge (or
      // the bottom of the screen, for a section running below the fold).
      const revealIn = Math.max(0, reach(Math.min(rect.bottom, vh)));
      revealEnd = Math.max(revealEnd, revealIn + FADE_MS);

      const bars: Bar[] = [];
      for (const node of section.content) traceBars(node, vh, bars);
      const group = document.createElement("div");
      if (section.flare) group.className = "on-flare";
      for (const bar of bars) {
        const span = document.createElement("span");
        span.className = `grid-skeleton-${bar.kind}`;
        const inset = bar.kind === "text" ? bar.rect.height * 0.22 : 0;
        span.style.left = `${bar.rect.left - wrapRect.left}px`;
        span.style.top = `${bar.rect.top - wrapRect.top + inset}px`;
        span.style.width = `${bar.rect.width}px`;
        span.style.height = `${bar.rect.height - inset * 2}px`;
        group.appendChild(span);
        animations.push(span.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: BAR_FADE_MS, delay: reach(bar.rect.top), easing: "ease-out", fill: "backwards",
        }));
      }
      layer.appendChild(group);
      // A crossfade: the content comes up quickly while the skeleton lingers
      // under it and eases away, so the swap never shows a blank or a pop.
      animations.push(group.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS, delay: revealIn, easing: "cubic-bezier(0.4, 0, 0.6, 1)", fill: "forwards",
      }));
      for (const node of section.content) {
        animations.push(node.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: FADE_MS * 0.8, delay: revealIn, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards",
        }));
      }
    }

    if (layer.childElementCount) wrap.appendChild(layer);
    const removeLayer = window.setTimeout(() => layer.remove(), revealEnd + 50);
    // Done growing: later mounts inside this shell (a section that appears
    // once data lands) show up without replaying the grid.
    const stopGrow = window.setTimeout(() => { delete wrap.dataset.grow; }, Math.min(gridEnd, 3000) + 50);

    return () => {
      window.clearTimeout(removeLayer);
      window.clearTimeout(stopGrow);
      animations.forEach((a) => a.cancel());
      layer.remove();
      delete wrap.dataset.grow;
    };
    // Runs once per mount: a new page (or a page swapping its loading state
    // for content) mounts a new shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
