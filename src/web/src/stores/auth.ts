import { useSyncExternalStore } from "react";

export type User = {
  id: string;
  username: string;
  isAdmin: boolean;
  webauthnEnabled?: boolean;
  permissions: string[];
};

type AuthState = {
  token: string | null;
  user: User | null;
  tempToken: string | null;
};

let state: AuthState = loadFromStorage();

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function loadFromStorage(): AuthState {
  try {
    const stored = localStorage.getItem("ocd-auth");
    if (stored) {
      const parsed = JSON.parse(stored);
      return { token: parsed.token || null, user: parsed.user || null, tempToken: null };
    }
  } catch (err) {
    console.error("Failed to load auth state from storage:", err);
  }
  return { token: null, user: null, tempToken: null };
}

function saveToStorage() {
  if (state.token && state.user) {
    localStorage.setItem("ocd-auth", JSON.stringify({ token: state.token, user: state.user }));
  } else {
    localStorage.removeItem("ocd-auth");
  }
}

export function login(token: string, user: User) {
  state = { ...state, token, user, tempToken: null };
  saveToStorage();
  notify();
}

export function logout() {
  state = { token: null, user: null, tempToken: null };
  saveToStorage();
  notify();
}

export function setTempToken(tempToken: string) {
  state = { ...state, tempToken };
  notify();
}

export function updateUser(user: User) {
  state = { ...state, user };
  saveToStorage();
  notify();
}

export function getToken(): string | null {
  return state.token;
}

export function useAuth() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

/** Mirror of the server's rule (see shared/db/users.ts `hasPermission`).
 *  Cosmetic only: the server re-checks every request. */
function evaluate(user: User | null, permission: string): boolean {
  if (!user) return false;
  return user.isAdmin || user.permissions.includes(permission);
}

export function useHasPermission(permission: string): boolean {
  const auth = useAuth();
  return evaluate(auth.user, permission);
}
