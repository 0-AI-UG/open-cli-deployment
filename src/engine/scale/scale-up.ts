import * as db from "../../shared/db.ts";
import { resolveAppEnvVars } from "../../shared/env-crypto.ts";
import {
  sshExec, pullImmutableImage,
  probeAppHealth, startAppReplica,
} from "../../shared/remote/index.ts";
import { type ProgressFn, log, type App, type Replica, type Server, replicaBindHost, appReplicaRunOpts } from "./types.ts";
import { syncAppIngress } from "./traefik-manager.ts";
import { attestReplica, hashEnvironment, latestDesiredImage } from "../revision.ts";

/**
 * Start `count` new replicas of an app on one explicitly placed server. The
 * caller decides the server from the app's declared placement; this never
 * chooses a server or provisions capacity.
 */
export async function addReplicas(
  app: App,
  targetServer: Server,
  count: number,
  emit: ProgressFn,
  preReservedPort?: { id: number; server_id: number; bind_address: string; host_port: number },
) {
  if (targetServer.status !== "ready") {
    throw new Error(`Server ${targetServer.name} is not ready (status: ${targetServer.status})`);
  }
  for (let i = 0; i < count; i++) {
    const existing = db.getReplicas(app.id);
    let replicaNum = existing.length + 1;
    const existingNames = new Set(existing.map((replica) => replica.container_name));
    while (existingNames.has(`${app.name}-r${replicaNum}`)) replicaNum++;
    emit("scale", `Starting replica ${replicaNum} on ${targetServer.name} (${i + 1}/${count})...`);

    const targetHostKey = targetServer.ssh_host_key || undefined;

    // Prefer the app's existing host port so the cross-server layout stays
    // easy to reason about; a second replica on the same server (or a port
    // already held there) gets the server's next free port. The ingress
    // upstream list reads each replica row's own port.
    const primaryHostPort = preReservedPort?.host_port ?? existing[0]?.host_port;
    const portTaken = (port: number) => db.getReplicasByServer(targetServer.id).some((replica) => replica.host_port === port);
    const hostPort = primaryHostPort !== undefined && !portTaken(primaryHostPort)
      ? primaryHostPort
      : db.nextReplicaHostPort(targetServer.id);

    // Bind the replica on the target server's private IPv4. Traffic from
    // the ingress layer uses the private network, so the public NIC is
    // never touched for inter-server app traffic. Fails fast if the
    // target isn't yet attached to the shared network.
    const replicaBindAddr = replicaBindHost(targetServer);
    const containerName = `${app.name}-r${replicaNum}`;

    // Claim and verify the complete bind tuple before pulling the image. The DB
    // reservation serializes OCD operations; the Docker probe catches an
    // orphan or out-of-band workload unknown to the DB.
    const usePreReserved = !!preReservedPort && i === 0 && preReservedPort.host_port === hostPort;
    const ownsReservation = !usePreReserved;
    const reservation = usePreReserved ? preReservedPort! : db.reserveHostPort({
        serverId: targetServer.id,
        bindAddress: replicaBindAddr,
        hostPort,
        protocol: "tcp",
        ownerType: "replica",
        ownerId: `${app.id}:${containerName}`,
      });
    if (
      reservation.server_id !== targetServer.id ||
      reservation.bind_address !== replicaBindAddr ||
      reservation.host_port !== hostPort
    ) throw new Error("Pre-reserved port tuple does not match selected target");
    let inserted: Replica | null = null;
    try {
      const bindProbe = await sshExec(
        targetServer.ipv4,
        `su - deploy -c ${JSON.stringify(`docker ps --filter publish=${hostPort} --format '{{.Names}}'`)}`,
        targetHostKey,
      );
      const conflicts = bindProbe.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean)
        .filter((name) => name !== containerName);
      if (bindProbe.exitCode !== 0 || conflicts.length > 0) {
        throw new Error(
          `Port preflight failed for ${replicaBindAddr}:${hostPort}/tcp` +
            (conflicts.length ? `; held by ${conflicts.join(", ")}` : `; Docker probe failed`),
        );
      }

    // Every host pulls the exact registry digest with the fleet's configured
    // OCI credentials when the registry matches.
    const imageName = latestDesiredImage(app);
    emit("scale", `Pulling ${imageName} on ${targetServer.name}...`);
    await pullImmutableImage(targetServer.ipv4, {
      name: app.name,
      imageRef: imageName,
      hostKey: targetHostKey,
    }, (line) => emit("pull", line));

    // startAppReplica force-removes any same-named squatter first: a previous
    // failed scale-up or migration may have left one holding the private-IP
    // host port, which would make the run fail with "port already allocated".
    const resolvedEnv = await resolveAppEnvVars(app);
    await startAppReplica(targetServer.ipv4, {
      ...appReplicaRunOpts(app, targetServer, { containerName, hostPort, envVars: resolvedEnv }),
      image: imageName,
    }, targetHostKey);

    // Health check
    emit("scale", `Health checking replica ${replicaNum}...`);
    const health = await probeAppHealth(app, targetServer.ipv4, containerName, replicaBindAddr, hostPort, 5, targetHostKey);

    // Insert replica record BEFORE syncing ingress so the upstream pool
    // built from the DB actually includes the new replica.
    inserted = db.insertReplica({
      app_id: app.id,
      server_id: targetServer.id,
      host_port: hostPort,
      container_name: containerName,
      status: health.healthy ? "attesting" : "unhealthy",
    });

    if (!health.healthy) {
      throw new Error(`Replica ${containerName} did not become healthy and will not be attached to ingress`);
    }
    const desiredDeployment = db.getDeployments(app.id).find((d) => d.status === "deployed");
    const expected = {
      imageDigest: desiredDeployment?.image_digest || app.image_ref || imageName,
      envHash: hashEnvironment(resolvedEnv),
      configRevision: app.config_revision,
    };
    const attestation = await attestReplica(app, inserted, targetServer, expected);
    if (!attestation.ok) {
      throw new Error(`Replica ${inserted.id} revision attestation failed: ${attestation.error}`);
    }
    db.updateReplicaStatus(inserted.id, "running");

    // Push the updated upstream pool to the fleet ingress. One re-render per
    // replica is fine — dynamic config writes are atomic (tmp+mv).
    await syncAppIngress(app.id);

    emit("scale", `Replica ${replicaNum} deployed on ${targetServer.name}`);
    } catch (error) {
      // One replica iteration is a work boundary even when its caller wraps a
      // larger scale/deploy step. A failure before return must remove its own
      // possibly-started container and DB row because the runner cannot invoke
      // a compensation hook for an incomplete caller step.
      const removal = await sshExec(
        targetServer.ipv4,
        `su - deploy -c ${JSON.stringify(`docker rm -f ${containerName} 2>/dev/null || true`)}`,
        targetHostKey,
      );
      if (inserted) db.deleteReplica(inserted.id);
      try { await syncAppIngress(app.id); } catch { /* best-effort convergence */ }
      if (removal.exitCode !== 0) {
        throw new Error(
          `Replica setup failed and partial container ${containerName} could not be removed (ssh exit ${removal.exitCode})`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (ownsReservation) db.releaseHostPortReservation(reservation.id);
    }
  }
}

export async function rollbackScaleUp(
  app: App,
  originalReplicas: Replica[],
  emit: ProgressFn
): Promise<void> {
  const freshApp = db.getApp(app.id);
  if (!freshApp) return;

  // Find replicas that were added (not in the original set)
  const originalIds = new Set(originalReplicas.map(r => r.id));
  const currentReplicas = db.getReplicas(app.id);
  const newReplicas = currentReplicas.filter(r => !originalIds.has(r.id));

  // Remove new replicas
  for (const replica of newReplicas) {
    const server = db.getServer(replica.server_id);
    if (server) {
      const hostKey = server.ssh_host_key || undefined;
      try {
        await sshExec(server.ipv4, `su - deploy -c "docker rm -f ${replica.container_name} 2>/dev/null || true"`, hostKey);
      } catch (err) {
        log("scale", `Rollback: failed to remove container ${replica.container_name}: ${err}`);
      }
    }
    db.deleteReplica(replica.id);
  }

  // Re-render ingress so it reflects the remaining replicas.
  try {
    await syncAppIngress(app.id);
  } catch (err) {
    log("rollback", `Failed to sync ingress after rollback: ${err}`);
  }

  emit("scale", "Rollback complete");
  log("rollback", `Scale-up rollback complete for app ${app.id}`);
}
