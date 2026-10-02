import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { type ProgressFn, log, type App, type Replica } from "./types.ts";

/** Drain and remove exactly the given replicas. Never touches the app's
 * declared placement: a failed removal is retried by the next convergence
 * pass instead of redefining what the user asked for. */
export async function removeReplicas(
  app: App,
  toRemove: Replica[],
  emit: ProgressFn,
) {
  let removedCount = 0;
  for (const replica of toRemove) {
    try {
      emit("scale", `Draining replica ${replica.container_name}...`);

      const server = db.getServer(replica.server_id);
      if (!server) {
        // The server row itself is gone, so no container can remain.
        db.deleteReplica(replica.id);
        removedCount++;
        continue;
      }
      const hostKey = server.ssh_host_key || undefined;

      // Drop the replica from the ingress upstream pool first so in-flight
      // requests drain through the remaining healthy replicas instead of
      // the one we're about to stop.
      db.updateReplicaStatus(replica.id, "draining");
      try {
        await syncAppIngress(app.id);
      } catch (err) {
        log("scale", `Ingress sync during drain failed (continuing): ${err}`);
      }
      emit("scale", `Waiting 10s drain for ${replica.container_name}...`);
      await Bun.sleep(10_000);

      const asUser = (cmd: string) => `su - deploy -c ${JSON.stringify(cmd)}`;

      await sshExec(server.ipv4, asUser(`docker rm -f ${replica.container_name} 2>/dev/null || true`), hostKey);

      db.deleteReplica(replica.id);
      emit("scale", `Replica ${replica.container_name} removed`);
      removedCount++;
    } catch (err) {
      log("scale", `Failed to remove replica ${replica.container_name}: ${err}`);
      // Stop attempting further removals — don't make things worse
      break;
    }
  }

  if (removedCount < toRemove.length) {
    throw new Error(`Replica removal incomplete — removed ${removedCount} of ${toRemove.length}; the next convergence pass retries.`);
  }

  // Re-render ingress so the upstream pool matches what's left. The
  // draining-phase sync above already removed the draining replicas; this
  // second sync is belt-and-braces.
  try {
    await syncAppIngress(app.id);
  } catch (err) {
    log("scale", `Ingress sync after replica removal failed: ${err}`);
  }
}

/** Removal order within one server: unhealthy replicas first, then newest. */
export function removalOrder(replicas: Replica[]): Replica[] {
  return [...replicas].sort((a, b) => {
    if (a.status !== "running" && b.status === "running") return -1;
    if (a.status === "running" && b.status !== "running") return 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}
