import { deleteAppNtfy } from "../../shared/ntfy.ts";
import { deleteAppStorage } from "../../shared/object-storage.ts";
import * as db from "../../shared/db.ts";
import {
  sshExec,
  removeContainer,
} from "../../shared/remote/index.ts";
import { syncAllTraefik } from "../scale/traefik-manager.ts";
import { requireStorageDriver } from "../storage/index.ts";
import { registerOp } from "./registry.ts";
import { assertCleanupComplete, softStep, runDbCleanupGate } from "./_shared.ts";
import type { OpKindDefinition, Step } from "../types.ts";

type DestroyInput = {
  appId: number;
  /** Failed-deploy cleanup may expire automatically after the recovery window. */
  retentionClass?: "user" | "provisional";
};

const markDeleting: Step<DestroyInput, { ok: true }> = {
  name: "mark_deleting",
  label: "Mark deletion intent",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (app) {
      if (app.public && app.domain && !app.domain.endsWith(".nip.io")) {
        ctx.log(`DNS cleanup is manual: remove the A record for ${app.domain} when it is no longer needed`);
      }
      db.markAppDeletionRequested(ctx.input.appId);
    }
    return { ok: true };
  },
};

const stopAndRemoveContainers: Step<DestroyInput, { affectedServerIds: number[]; failed: boolean }> = {
  name: "stop_and_remove_containers",
  label: "Stop and remove containers",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) return { affectedServerIds: [], failed: false };
    const replicas = db.getReplicas(ctx.input.appId);
    const affected = new Set<number>();
    let failed = false;
    for (const replica of replicas) {
      affected.add(replica.server_id);
      const server = db.getServer(replica.server_id);
      if (!server) {
        failed = true;
        ctx.log(`Cannot remove replica ${replica.container_name}: server #${replica.server_id} is missing`);
        continue;
      }
      const hostKey = server.ssh_host_key || undefined;
      const r = await softStep(ctx, `rm ${replica.container_name}`, async () => {
        await removeContainer(server.ipv4, replica.container_name, hostKey);
      });
      if (!r.ok) failed = true;
      const directory = await softStep(ctx, `rmdir ${app.name}`, async () => {
        const result = await sshExec(server.ipv4, `rm -rf /home/deploy/apps/${app.name}`, hostKey);
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
      });
      if (!directory.ok) failed = true;
    }
    return { affectedServerIds: Array.from(affected), failed };
  },
};

// Runs AFTER delete_db_rows: ingress is a desired-state render of the DB, so
// the app's routers only disappear from the rendered config once its rows are
// gone. (If the row deletion was skipped because of upstream failures, this
// re-render is a harmless no-op and the reconciler converges later.)
const removeIngressRoute: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "remove_ingress_route",
  label: "Remove ingress route",
  async run(ctx) {
    const r = await softStep(ctx, "remove_ingress_route", async () => {
      await syncAllTraefik();
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

const deleteVolume: Step<DestroyInput, { ok: boolean; error?: string }> = {
  name: "delete_volume",
  label: "Detach and retain volume",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app || !app.volume_id) return { ok: true };
    const r = await softStep(ctx, "delete_volume", async () => {
      const serverId = db.getReplicas(app.id)[0]?.server_id;
      const server = serverId == null ? undefined : db.getServer(serverId) ?? undefined;
      await requireStorageDriver(app.volume_driver).detach(app.volume_id, server);
      db.retireVolume({
        providerVolumeId: app.volume_id,
        driverId: app.volume_driver,
        formerResourceType: "app",
        formerResourceId: app.id,
        formerResourceName: app.name,
        reason: `app destroy operation #${ctx.opId}`,
        retentionClass: ctx.input.retentionClass ?? "user",
      });
      ctx.log(`Detached volume ${app.volume_id}; retained for recovery for 7 days`);
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

type DeleteDbRowsOut = { ok: boolean; failed: boolean; failedSteps: string[] };

const deleteDbRows: Step<DestroyInput, DeleteDbRowsOut> = {
  name: "delete_db_rows",
  label: "Delete DB rows",
  async run(ctx, prior) {
    // Gate: if ANY upstream destroy step partially failed, do not delete DB
    // rows. Mark the app `cleanup_failed` and surface to the reconciler.
    const failedSteps = runDbCleanupGate(prior);
    if (failedSteps.length > 0) {
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Some resources could not be cleaned up (failed: ${failedSteps.join(", ")}) — app marked cleanup_failed`);
      return { ok: false, failed: true, failedSteps };
    }
    const replicas = db.getReplicas(ctx.input.appId);
    const dbFailures: string[] = [];
    for (const replica of replicas) {
      const result = await softStep(ctx, `delete_replica ${replica.id}`, async () => {
        db.deleteReplica(replica.id);
      });
      if (!result.ok) dbFailures.push(`replica:${replica.id}`);
    }
    // Preserve the app as the retry/recovery anchor when a child row could not
    // be removed. Deleting it may cascade the evidence needed for recovery.
    if (dbFailures.length === 0) {
      const result = await softStep(ctx, "delete_app", async () => {
        deleteAppStorage(ctx.input.appId);
        deleteAppNtfy(ctx.input.appId);
        db.deleteApp(ctx.input.appId);
      });
      if (!result.ok) dbFailures.push(`app:${ctx.input.appId}`);
    }
    if (dbFailures.length > 0) {
      try { db.updateAppStatus(ctx.input.appId, "cleanup_failed"); } catch { /* ignore */ }
      ctx.log(`Database cleanup failed (${dbFailures.join(", ")}) — app marked cleanup_failed`);
      return { ok: false, failed: true, failedSteps: dbFailures };
    }
    return { ok: true, failed: false, failedSteps: [] };
  },
};

const assertDbCleanup: Step<DestroyInput, { ok: true }> = {
  name: "assert_db_cleanup",
  label: "Verify cleanup completed",
  async run(_ctx, prior) {
    assertCleanupComplete(prior, ["delete_db_rows"]);
    return { ok: true };
  },
};

const destroyAppOp: OpKindDefinition<DestroyInput> = {
  kind: "destroy_app",
  label: "Destroy app",
  resourceKeys: (input) => {
    const volumeId = db.getApp(input.appId)?.volume_id;
    return [`app:${input.appId}`, ...(volumeId ? [`volume:${volumeId}`] : [])];
  },
  steps: [
    markDeleting,
    stopAndRemoveContainers,
    deleteVolume,
    deleteDbRows,
    removeIngressRoute,
    assertDbCleanup,
  ],
};

registerOp(destroyAppOp as OpKindDefinition<any>);

export default destroyAppOp;
export type { DestroyInput };
