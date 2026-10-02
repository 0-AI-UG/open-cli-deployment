import * as db from "../shared/db.ts";
import { hetzner } from "../shared/hetzner/index.ts";

/**
 * Ensure the shared Hetzner private network exists and that its id is
 * persisted in the `network_id` setting. Returns the stored id.
 *
 * Callers should invoke this from any code path that is about to create a
 * server (so new servers get attached to the network at boot) or attach an
 * existing server (reconciler pass).
 */
export async function ensureNetwork(): Promise<string> {
  const stored = db.getSettings().network_id;
  if (stored) return stored;
  const { id } = await hetzner.networks.ensure();
  db.saveSetting("network_id", id);
  return id;
}
