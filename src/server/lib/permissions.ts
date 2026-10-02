import { authenticateRequest, type TokenPayload } from "./auth.ts";
import { AuthError, PermissionError } from "./errors.ts";
import { getUserById, hasPermission } from "../../shared/db.ts";

/** Authenticate, then check a global permission. */
export async function requirePermission(
  request: Request,
  permission: string,
): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");

  assertCliAccess(payload);

  if (user.is_admin) return payload;
  if (!hasPermission(payload.userId, permission)) {
    throw new PermissionError(`Missing permission: ${permission}`);
  }
  return payload;
}

/** Require a permission through a CLI-minted token.
 *
 * Desired-state entry points use this instead of duplicating client checks in
 * individual routes. Browser sessions may operate resources, but cannot apply
 * manifests or create manifest-owned resources.
 */
export async function requireCliPermission(
  request: Request,
  permission: string,
): Promise<TokenPayload> {
  const payload = await requirePermission(request, permission);
  if (payload.client !== "cli") {
    throw new PermissionError("This action is only available through the ocd CLI");
  }
  return payload;
}

/** Every CLI-minted token additionally has to carry `cli.access`, regardless of
 *  which permission was requested — so revoking it locks an account to the web
 *  UI without touching any other grant. Non-CLI tokens are unaffected. */
export function assertCliAccess(payload: TokenPayload): void {
  if (payload.client !== "cli") return;
  const user = getUserById(payload.userId);
  if (user?.is_admin) return;
  if (!hasPermission(payload.userId, "cli.access")) {
    throw new PermissionError("CLI access is not enabled for this account");
  }
}

/** Authenticate with no permission requirement, but still enforce cli.access.
 *  For the handful of routes that are open to any signed-in user. */
export async function requireAuthenticated(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  assertCliAccess(payload);
  return payload;
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  if (!user.is_admin) throw new PermissionError("Admin only");
  return payload;
}
