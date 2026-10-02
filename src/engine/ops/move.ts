import * as db from "../../shared/db.ts";
import { assertPlacementUsable } from "../../shared/app-config.ts";
import { parsePlacement, type Placement } from "../../shared/placement.ts";
import { migrateVolumeReplica, rollbackMigrateWithVolume, type VolumeMigrationContext } from "../scale/migrate.ts";
import { addReplicas } from "../scale/scale-up.ts";
import { removeReplicas } from "../scale/scale-down.ts";
import { syncAppIngress } from "../scale/traefik-manager.ts";
import { pullImmutableImage } from "../../shared/remote/index.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition, Step } from "../types.ts";
import { latestDesiredImage } from "../revision.ts";
import { requireStorageDriver } from "../storage/index.ts";

/** Move every replica an app runs on one server to another server, then
 * record the new placement. Stateless apps start the target replicas before
 * removing the source ones; volume apps stop, move the volume, and restart. */
export type MoveInput = { appId: number; fromServerId: number; toServerId: number };

type ValidateOut = { count: number; withVolume: boolean };
type MoveOut = { sourceServerName: string; targetServerName: string; count: number; withVolume: boolean };

/** The placement after moving `from`'s replicas onto `to`. */
export function movedPlacement(placement: Placement, fromServerId: number, toServerId: number): Placement {
  const next: Placement = { ...placement };
  const count = next[String(fromServerId)] ?? 0;
  delete next[String(fromServerId)];
  next[String(toServerId)] = (next[String(toServerId)] ?? 0) + count;
  return next;
}

const loadAndValidate: Step<MoveInput, ValidateOut> = {
  name: "load_and_validate",
  label: "Validate move",
  async run(ctx) {
    const { appId, fromServerId, toServerId } = ctx.input;
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    if (fromServerId === toServerId) throw new Error("Source and target server are the same");
    const placement = parsePlacement(app.placement);
    const count = placement[String(fromServerId)];
    if (!count) {
      const source = db.getServer(fromServerId);
      throw new Error(`App ${app.name} is not placed on ${source?.name ?? `server #${fromServerId}`}`);
    }
    assertPlacementUsable({ [String(toServerId)]: 1 });
    if (db.parseExtraVolumes(app.extra_volumes).length > 0) {
      throw new Error("Apps with host-directory mounts cannot move between servers");
    }
    if (app.volume_id) {
      const driver = requireStorageDriver(app.volume_driver);
      if (!driver.portable) {
        throw new Error(`Volume ${app.volume_id} uses non-portable storage driver ${driver.id}`);
      }
    }
    return { count, withVolume: !!app.volume_id };
  },
};

// For volume-backed apps, pull the exact registry digest to the target before
// any destructive volume move begins.
const preflightImage: Step<MoveInput, { ok: true }> = {
  name: "preflight_image",
  label: "Preflight image availability",
  async run(ctx) {
    const app = db.getApp(ctx.input.appId);
    if (!app) throw new Error("App not found");
    if (!app.volume_id) return { ok: true }; // stateless path never stops the source first
    const target = db.getServer(ctx.input.toServerId);
    if (!target) throw new Error("Target server not found");
    await pullImmutableImage(target.ipv4, {
      name: app.name,
      imageRef: latestDesiredImage(app),
      hostKey: target.ssh_host_key || undefined,
    }, (line) => ctx.log(`[preflight-pull] ${line}`));
    return { ok: true };
  },
};

const performMove: Step<MoveInput, MoveOut> = {
  name: "perform_move",
  label: "Move replicas",
  async run(ctx) {
    const { appId, fromServerId, toServerId } = ctx.input;
    const app = db.getApp(appId);
    if (!app) throw new Error("App not found");
    const source = db.getServer(fromServerId);
    const target = db.getServer(toServerId);
    if (!source || !target) throw new Error("Server not found");
    const emit = (step: string, detail: string) => ctx.log(`[${step}] ${detail}`);
    const placement = parsePlacement(app.placement);
    const count = placement[String(fromServerId)];
    if (!count) {
      // A retry after the placement was already rewritten has nothing left to do.
      if (placement[String(toServerId)]) {
        return { sourceServerName: source.name, targetServerName: target.name, count: 0, withVolume: !!app.volume_id };
      }
      throw new Error(`App ${app.name} is not placed on ${source.name}`);
    }
    const next = movedPlacement(placement, fromServerId, toServerId);

    if (app.volume_id) {
      const replica = db.getReplicas(appId).find((candidate) => candidate.server_id === fromServerId);
      // Volume migrations destroy the source container before the new one
      // comes up. Only forward steps that returned have compensate hooks, so
      // rollback is handled inline here.
      const rb: VolumeMigrationContext = {};
      try {
        if (replica) {
          const result = await migrateVolumeReplica(appId, replica.id, toServerId, emit, rb);
          if (!result.ok) throw new Error(result.error || "Move failed");
        } else if (!db.getReplicas(appId).some((candidate) => candidate.server_id === toServerId)) {
          throw new Error(`App ${app.name} has no replica on ${source.name} to move`);
        }
      } catch (err) {
        if (rb.withVolume) {
          try {
            await rollbackMigrateWithVolume(rb, (line) => ctx.log(line));
          } catch (rbErr) {
            ctx.log(`MANUAL RECOVERY NEEDED: volume move rollback threw: ${rbErr}`);
          }
          try {
            await syncAppIngress(appId);
          } catch (ingressErr) {
            ctx.log(`Ingress resync during rollback failed: ${ingressErr}`);
          }
        }
        throw err;
      }
      db.updateAppPlacement(appId, next);
      return { sourceServerName: source.name, targetServerName: target.name, count, withVolume: true };
    }

    // Stateless: bring the target up to its new count first (idempotent on
    // retry), then drain and remove everything on the source.
    const onTarget = db.getReplicas(appId).filter((replica) => replica.server_id === toServerId).length;
    const missing = next[String(toServerId)] - onTarget;
    if (missing > 0) {
      emit("move", `Starting ${missing} replica(s) on ${target.name}...`);
      await addReplicas(app, target, missing, emit);
    }
    const sourceReplicas = db.getReplicas(appId).filter((replica) => replica.server_id === fromServerId);
    if (sourceReplicas.length > 0) {
      emit("move", `Removing ${sourceReplicas.length} replica(s) from ${source.name}...`);
      await removeReplicas(app, sourceReplicas, emit);
    }
    db.updateAppPlacement(appId, next);
    emit("move", `Move complete — ${app.name} now runs on ${target.name}`);
    return { sourceServerName: source.name, targetServerName: target.name, count, withVolume: false };
  },
};

const verifyHealthy: Step<MoveInput, { ok: true }> = {
  name: "verify_replicas_healthy",
  label: "Verify replicas healthy",
  async run(ctx) {
    const onTarget = db.getReplicas(ctx.input.appId).filter((replica) => replica.server_id === ctx.input.toServerId);
    const unhealthy = onTarget.filter((replica) => replica.status !== "running");
    if (onTarget.length === 0 || unhealthy.length > 0) {
      throw new Error(`Replicas on the target server are not running: ${unhealthy.map((r) => r.container_name).join(", ") || "none started"}`);
    }
    return { ok: true };
  },
};

const syncIngressStep: Step<MoveInput, { ok: true }> = {
  name: "sync_ingress",
  label: "Configure ingress",
  async run(ctx) {
    try {
      await syncAppIngress(ctx.input.appId);
    } catch (err) {
      ctx.log(`Ingress sync warning: ${err}`);
    }
    return { ok: true };
  },
};

const recordEvent: Step<MoveInput, { ok: true }> = {
  name: "record_event",
  label: "Record move event",
  async run(ctx, prior) {
    const out = prior["perform_move"] as MoveOut | undefined;
    if (!out || out.count === 0) return { ok: true };
    db.insertScalingEvent({
      app_id: ctx.input.appId,
      operation_id: ctx.opId,
      event_type: "move",
      from_count: out.count,
      to_count: out.count,
      reason: `Moved ${out.count} replica(s)${out.withVolume ? " with volume" : ""} from ${out.sourceServerName} to ${out.targetServerName}`,
    });
    return { ok: true };
  },
};

const moveOp: OpKindDefinition<MoveInput> = {
  kind: "move",
  label: "Move app",
  resourceKeys: (input) => [`app:${input.appId}`],
  steps: [loadAndValidate, preflightImage, performMove, verifyHealthy, syncIngressStep, recordEvent],
};

registerOp(moveOp as OpKindDefinition<any>);

export default moveOp;
