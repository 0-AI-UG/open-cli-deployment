import * as db from "../shared/db.ts";
import { isNotFoundError } from "../shared/hetzner/errors.ts";
import { ensureNetwork as ensureSharedNetwork } from "./network.ts";
import { requireStorageDriver } from "./storage/index.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "./scheduler.ts";
import { getHetznerToken } from "../shared/secret-store.ts";
import { hetzner } from "../shared/hetzner/index.ts";
import { syncPublicPortFirewalls } from "./public-ports.ts";

function log(context: string, ...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [infra-reconciler:${context}]`, ...args);
}

async function withLock(keys: string[], kind: string, work: () => Promise<void>): Promise<void> {
  const lock = tryAcquire(keys, NON_OP_HOLDER, kind);
  if (!lock.ok) return;
  try { await work(); } finally { release(keys); }
}

/** Observe Hetzner truth, repair private-network attachment, and make a
 * confirmed missing server unavailable to schedulers and routing. */
export async function reconcileServersAndNetwork(): Promise<void> {
  const servers = db.getServers().filter((server) => server.provider_id);
  if (servers.length === 0) return;
  if (!await getHetznerToken().catch(() => "")) return;
  for (const snapshot of servers) {
    await withLock([`server:${snapshot.id}`], "reconcile:server", async () => {
      const server = db.getServer(snapshot.id);
      if (!server) return;
      let networkId = "";
      try {
        networkId = await ensureSharedNetwork();
      } catch (error) {
        log("network", `Hetzner shared network reconciliation failed: ${error}`);
      }
      try {
        const observed = await hetzner.getServer(server.provider_id);
        const available = observed.status === "running";
        db.recordServerObservation(server.id, {
          providerStatus: observed.status,
          ipv4: observed.ipv4 || undefined,
          ipv6: observed.ipv6 || undefined,
          available,
        });
        const fresh = db.getServer(server.id);
        if (available && fresh?.status === "unavailable") db.updateServerStatus(server.id, "ready");
        if (!available && (fresh?.unavailable_ticks ?? 0) >= 2) {
          db.updateServerStatus(server.id, "unavailable");
          for (const replica of db.getReplicasByServer(server.id)) db.updateReplicaStatus(replica.id, "unhealthy");
        }
        if (!networkId) return;
        try {
          let routingAddress = await hetzner.networks.getPrivateIpv4(server.provider_id, networkId);
          if (!routingAddress) {
            // Hetzner authoritatively reports detachment. Stop routing to
            // the cached address before attempting repair.
            db.updateServer(server.id, { routing_address: "" });
            await hetzner.networks.attachServer(server.provider_id, networkId);
            routingAddress = await hetzner.networks.getPrivateIpv4(server.provider_id, networkId);
          }
          if (routingAddress) db.updateServer(server.id, { routing_address: routingAddress });
        } catch (networkError) {
          log("network", `${server.name}: attachment reconciliation failed: ${networkError}`);
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          log("server", `${server.name}: observation failed: ${error}`);
          return;
        }
        db.recordServerObservation(server.id, { providerStatus: "missing", available: false });
        const fresh = db.getServer(server.id);
        if ((fresh?.unavailable_ticks ?? 0) >= 2) {
          db.updateServerStatus(server.id, "unavailable");
          for (const replica of db.getReplicasByServer(server.id)) db.updateReplicaStatus(replica.id, "unhealthy");
        }
      }
    });
  }
}

/** Continuously reassert both firewall rules and server attachments. */
export async function reconcileFirewall(): Promise<void> {
  const servers = db.getServers().filter((server) =>
    server.provider_id && server.status !== "cleanup_failed"
  );
  if (servers.length === 0) return;
  if (!await getHetznerToken().catch(() => "")) return;
  await Promise.all(servers.map(async (server) => {
    try {
      const firewallId = await hetzner.ensureFirewall();
      await withLock(
        [`server:${server.id}`],
        "reconcile:firewall",
        () => hetzner.ensureFirewallAttached(firewallId, server.provider_id),
      );
    } catch (error) {
      log("firewall", `${server.name}: attachment reconciliation failed: ${error}`);
    }
  }));
  try {
    await syncPublicPortFirewalls();
  } catch (error) {
    log("firewall", `public-ports firewall reconciliation failed: ${error}`);
  }
}

type VolumeOwner = {
  key: string;
  volumeId: string;
  driverId: string;
  serverId: number;
  hostMountPath: string;
  blockName: string;
  markDegraded: (reason: string) => void;
};

function activeVolumeOwners(): VolumeOwner[] {
  const owners: VolumeOwner[] = [];
  for (const app of db.getApps()) {
    const replicas = db.getReplicas(app.id);
    const replica = replicas.find((candidate) =>
      candidate.status === "running" && db.getServer(candidate.server_id)?.status === "ready"
    ) ?? replicas.find((candidate) => db.getServer(candidate.server_id)?.status === "ready") ?? replicas[0];
    if (!app.volume_id || !app.volume_mount || !replica || app.deletion_requested_at) continue;
    owners.push({
      key: `app:${app.id}`,
      volumeId: app.volume_id,
      driverId: app.volume_driver,
      serverId: replica.server_id,
      hostMountPath: app.volume_mount.split(":")[0],
      blockName: `app-${app.id}`,
      markDegraded: (reason) => {
        const wasUnhealthy = db.getApp(app.id)?.status === "unhealthy";
        db.updateAppStatus(app.id, "unhealthy");
        if (!wasUnhealthy) db.appendDeployLog(app.id, `[volume] ${reason}`);
      },
    });
  }
  const panel = db.getPanel();
  if (panel?.volume_id && panel.volume_mount) {
    owners.push({
      key: `server:${panel.server_id}`,
      volumeId: panel.volume_id,
      driverId: panel.volume_driver,
      serverId: panel.server_id,
      hostMountPath: panel.volume_mount.split(":")[0],
      blockName: "panel",
      markDegraded: (reason) => log("volume", `panel: ${reason}`),
    });
  }
  return owners;
}

/** Repair unambiguous active-volume drift. A detached desired volume may be
 * reattached to its recorded host; a volume attached elsewhere is never moved
 * automatically and is surfaced as degraded instead. */
export async function reconcileActiveVolumes(): Promise<void> {
  for (const owner of activeVolumeOwners()) {
    const keys = [owner.key, `server:${owner.serverId}`, `volume:${owner.volumeId}`];
    try {
      await withLock([...new Set(keys)], "reconcile:volume", async () => {
        const server = db.getServer(owner.serverId);
        if (!server || server.status !== "ready") return;
        const driver = requireStorageDriver(owner.driverId);
        let volume;
        try {
          volume = await driver.inspect(owner.volumeId, server);
        } catch (error) {
          owner.markDegraded(
            isNotFoundError(error)
              ? `volume ${owner.volumeId} is missing`
              : `volume inspection failed: ${error}`,
          );
          return;
        }
        const expectedServerId = driver.portable ? server.provider_id : String(server.id);
        if (volume.attachedServerId && volume.attachedServerId !== expectedServerId) {
          owner.markDegraded(`volume ${owner.volumeId} is attached to unexpected server ${volume.attachedServerId}`);
          return;
        }
        if (!volume.attachedServerId) await driver.attach(owner.volumeId, server);
        await driver.ensureMount({
          server,
          volumeId: owner.volumeId,
          hostPath: owner.hostMountPath,
          blockName: owner.blockName,
        });
      });
    } catch (error) {
      owner.markDegraded(`volume reconciliation failed: ${error}`);
    }
  }
}
