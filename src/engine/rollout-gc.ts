import * as db from "../shared/db.ts";
import { serverGcProtections } from "../shared/gc-protection.ts";
import { garbageCollectServer } from "../shared/remote/index.ts";
import { assertRolloutDiskSpace } from "./hetzner/build.ts";

type Server = NonNullable<ReturnType<typeof db.getServer>>;
type Dependencies = {
  checkSpace: typeof assertRolloutDiskSpace;
  collect: typeof garbageCollectServer;
};
const defaultDependencies: Dependencies = {
  checkSpace: assertRolloutDiskSpace,
  collect: garbageCollectServer,
};

function rolloutServers(appNames: string[]): Server[] {
  const servers = new Map<number, Server>();
  for (const name of appNames) {
    const app = db.getAppByName(name);
    if (!app) continue;
    for (const replica of db.getReplicas(app.id)) {
      const server = db.getServer(replica.server_id);
      if (server) servers.set(server.id, server);
    }
  }
  return [...servers.values()];
}

async function cleanServer(server: Server, log: (message: string) => void, dependencies: Dependencies): Promise<void> {
  const result = await dependencies.collect(server.ipv4, server.ssh_host_key || undefined, {
    ...serverGcProtections(server.id),
    buildCacheKeepStorage: server.pool === "build-workers" ? "4GB" : "1GB",
  });
  log(`Docker cleanup on ${server.name}: freed ${(result.reclaimed_bytes / 1024 ** 3).toFixed(1)} GiB`);
}

/** Recover space once before rejecting a build whose current replicas cannot
 * receive the resulting image. The second probe still enforces the hard limit. */
export async function preflightRolloutSpace(
  appNames: string[], log: (message: string) => void, dependencies: Dependencies = defaultDependencies,
): Promise<void> {
  await Promise.all(rolloutServers(appNames).map(async (server) => {
    try {
      await dependencies.checkSpace(server.ipv4, server.ssh_host_key || undefined);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Insufficient Docker disk space")) throw error;
      log(`Low Docker disk space on ${server.name}; cleaning unused images before build`);
      await cleanServer(server, log, dependencies);
      await dependencies.checkSpace(server.ipv4, server.ssh_host_key || undefined);
    }
  }));
}

/** Reclaim unused image data after successful runtime reconciliation. Cleanup
 * errors are reported but cannot turn an already deployed release into a failed
 * delivery. The next preflight can retry cleanup if space is still low. */
export async function cleanAfterBuild(
  appNames: string[], log: (message: string) => void, dependencies: Dependencies = defaultDependencies,
): Promise<void> {
  await Promise.all(rolloutServers(appNames).map(async (server) => {
    try {
      await cleanServer(server, log, dependencies);
    } catch (error) {
      log(`Docker cleanup on ${server.name} failed: ${error}`);
    }
  }));
}
