import * as db from "../shared/db.ts";
import { hetzner } from "../shared/hetzner/index.ts";
import { parsePlacement } from "../shared/placement.ts";
import { desiredPublicPortFirewalls } from "../shared/public-ports.ts";
import { getHetznerToken } from "../shared/secret-store.ts";
import type { DesiredPublicPortsFirewall } from "./hetzner/servers.ts";

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [public-ports]`, ...args);
}

/** The firewall every server must hold for the apps placed on it. Apps listed
 * in `excludeAppIds` count as gone (a failed first deploy compensating). */
export function publicPortsFirewallsFromDb(excludeAppIds: number[] = []): DesiredPublicPortsFirewall[] {
  const excluded = new Set(excludeAppIds);
  const apps = db.getApps()
    .filter((app) => !excluded.has(app.id))
    .map((app) => ({
      name: app.name,
      placement: parsePlacement(app.placement),
      public_ports: db.parseAppPublicPorts(app),
    }));
  const desired: DesiredPublicPortsFirewall[] = [];
  for (const [serverId, rules] of desiredPublicPortFirewalls(apps)) {
    const server = db.getServer(serverId);
    if (!server?.provider_id) continue;
    desired.push({ serverId, providerId: server.provider_id, rules });
  }
  return desired.sort((a, b) => a.serverId - b.serverId);
}

/**
 * Open exactly the declared public ports on every server and close the rest.
 * Called by operations that change which apps hold public ports where, and
 * by the firewall controller, which repairs drift and finishes deletions.
 */
export async function syncPublicPortFirewalls(opts: { excludeAppIds?: number[] } = {}): Promise<void> {
  // One pass at a time in this process: a deploy and the controller planning
  // concurrently would both create the same server's firewall.
  const run = queue.then(() => syncOnce(opts));
  queue = run.catch(() => {});
  return run;
}

let queue: Promise<void> = Promise.resolve();

async function syncOnce(opts: { excludeAppIds?: number[] }): Promise<void> {
  if (!await getHetznerToken().catch(() => "")) {
    log("No Hetzner token configured; public-ports firewalls not reconciled");
    return;
  }
  const changes = await hetzner.reconcilePublicPortsFirewalls(publicPortsFirewallsFromDb(opts.excludeAppIds));
  if (changes > 0) log(`Applied ${changes} public-ports firewall change(s)`);
}
