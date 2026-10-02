import { useEffect, useState } from "react";

// A page tab or filter kept in the hash route's query (#/resources?section=servers),
// so the header menus can link straight to it. Changing it rewrites the URL in
// place: no history entry and no hashchange, so the app doesn't re-route.
function readParam(key: string) {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(key);
}

export function useHashParam<K extends string>(key: string, allowed: readonly K[], fallback: K): [K, (next: K) => void] {
  const parse = () => {
    const value = readParam(key);
    return allowed.includes(value as K) ? (value as K) : fallback;
  };
  const [value, setValue] = useState<K>(parse);

  useEffect(() => {
    const sync = () => setValue(parse());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [key]);

  const set = (next: K) => {
    setValue(next);
    const [path, query = ""] = window.location.hash.split("?");
    const params = new URLSearchParams(query);
    if (next === fallback) params.delete(key);
    else params.set(key, next);
    const search = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${location.search}${path}${search ? `?${search}` : ""}`);
  };

  return [value, set];
}
