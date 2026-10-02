import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "ocd-theme";
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {}
  return "light";
}

let preference: ThemePreference = read();

// Light is the default until the user picks something else.
// "system" leaves data-theme unset so the prefers-color-scheme rules in
// global.css decide; an explicit choice pins the attribute.
function apply() {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

apply();

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {}
  apply();
  listeners.forEach((listener) => listener());
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preference,
  );
}

// The theme actually on screen: the explicit choice, or the OS preference
// when following the system.
const darkQuery = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

export function useResolvedTheme(): "light" | "dark" {
  const pref = useThemePreference();
  const systemDark = useSyncExternalStore(
    (listener) => {
      darkQuery?.addEventListener("change", listener);
      return () => darkQuery?.removeEventListener("change", listener);
    },
    () => darkQuery?.matches ?? false,
  );
  if (pref !== "system") return pref;
  return systemDark ? "dark" : "light";
}
