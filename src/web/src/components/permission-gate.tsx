import { useHasPermission } from "../stores/auth.ts";
import type { ReactNode } from "react";

/** Show `children` only when the signed-in user holds `permission`. This is
 *  cosmetic — the server re-checks every request. */
export function PermissionGate({
  permission,
  children,
  fallback,
}: {
  permission: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  if (!useHasPermission(permission)) return fallback ?? null;
  return <>{children}</>;
}
