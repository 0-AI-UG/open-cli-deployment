import { authenticateRequest, type TokenPayload } from "./auth.ts";
import { AuthError, PermissionError } from "./errors.ts";
import { getUserById } from "../../shared/db.ts";

/** Authenticate and require that the user still exists. Every signed-in user
 *  can do everything. */
export async function requireAuthenticated(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  return payload;
}

/** Require a CLI-minted token.
 *
 * Desired-state entry points use this instead of duplicating client checks in
 * individual routes. Browser sessions may operate resources, but cannot apply
 * manifests or create manifest-owned resources.
 */
export async function requireCli(request: Request): Promise<TokenPayload> {
  const payload = await requireAuthenticated(request);
  if (payload.client !== "cli") {
    throw new PermissionError("This action is only available through the ocd CLI");
  }
  return payload;
}
