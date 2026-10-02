import * as db from "../../shared/db.ts";
import { parsePlacement } from "../../shared/placement.ts";
import { log, type ProgressFn, type Replica } from "./types.ts";
import { addReplicas, rollbackScaleUp } from "./scale-up.ts";
import { removeReplicas, removalOrder } from "./scale-down.ts";
import { tryAcquire, release } from "../scheduler.ts";

// Statuses in which an app's replicas are eligible for convergence.
// Everything else — paused, deploying, error — is owned by its own state machine and must be
// left untouched here.
const CONVERGEABLE = new Set(["running", "unhealthy"]);

// Sentinel op id for the reconciler's hold on `app:<id>`. Negative so it can
// never collide with a real operations-table row id.
const RECONCILER_OP_ID = -1;

export type ConvergencePlan = {
  /** Replicas to start, per placed ready server. */
  add: Array<{ serverId: number; count: number }>;
  /** Surplus replicas on placed ready servers. */
  removeSurplus: Replica[];
  /** Replicas on servers outside the placement; removed only once every placed
   *  server runs its declared count. */
  removeUnplaced: Replica[];
  /** Placed servers that are missing or not ready — left exactly as they are. */
  unavailable: number[];
};

/** Pure diff between the declared placement and the replica rows. */
export function planConvergence(
  placement: Record<string, number>,
  replicas: Replica[],
  serverStatus: (serverId: number) => string | null,
): ConvergencePlan {
  const plan: ConvergencePlan = { add: [], removeSurplus: [], removeUnplaced: [], unavailable: [] };
  const byServer = new Map<number, Replica[]>();
  for (const replica of replicas) {
    byServer.set(replica.server_id, [...(byServer.get(replica.server_id) ?? []), replica]);
  }
  for (const [key, count] of Object.entries(placement)) {
    const serverId = Number(key);
    const current = byServer.get(serverId) ?? [];
    if (serverStatus(serverId) !== "ready") {
      // Never compensate elsewhere: an unavailable placed server keeps its
      // replica rows and the app reports unhealthy until it returns.
      plan.unavailable.push(serverId);
      continue;
    }
    if (current.length < count) plan.add.push({ serverId, count: count - current.length });
    if (current.length > count) plan.removeSurplus.push(...removalOrder(current).slice(0, current.length - count));
  }
  for (const [serverId, current] of byServer) {
    if (placement[String(serverId)] !== undefined) continue;
    const status = serverStatus(serverId);
    // A replica on an unreachable server cannot be removed safely; keep the
    // row so its container is cleaned up once the server returns.
    if (status !== null && status !== "ready") continue;
    plan.removeUnplaced.push(...current);
  }
  return plan;
}

function placementSatisfied(appId: number, placement: Record<string, number>): boolean {
  const running = db.getReplicas(appId).filter((replica) => replica.status === "running");
  return Object.entries(placement).every(([serverId, count]) =>
    running.filter((replica) => replica.server_id === Number(serverId)).length >= count
  );
}

/**
 * Level-triggered replica convergence: make the app's replicas match its
 * user-declared placement exactly. Per placed server it starts missing
 * replicas and removes surplus ones; replicas on servers outside the
 * placement are removed only after every placed server runs its declared
 * count. OCD never picks a server, never changes the placement, and never
 * reschedules replicas away from an unavailable server.
 */
export async function convergeAppReplicas(appId: number): Promise<void> {
  const app = db.getApp(appId);
  if (!app || !CONVERGEABLE.has(app.status)) return;
  const placement = parsePlacement(app.placement);
  if (Object.keys(placement).length === 0) return;

  const replicas = db.getReplicas(appId);
  const plan = planConvergence(placement, replicas, (serverId) => db.getServer(serverId)?.status ?? null);
  if (plan.add.length === 0 && plan.removeSurplus.length === 0 && plan.removeUnplaced.length === 0) return;

  // A persistent volume is single-writer state bound to its one server. Only
  // `ocd move` relocates it; convergence never starts a volume app from zero
  // or touches a replica outside its placement.
  if (app.volume_id && (replicas.length === 0 || plan.removeUnplaced.length > 0)) {
    log("converge", `app ${appId}: volume app does not match its placement — run ocd move`);
    return;
  }

  // Serialize against saga ops (deploy child, move, redeploy, rollback)
  // mutating the same app. Non-blocking: if a real op holds the app lock we
  // skip this tick — the next tick re-derives the gap and tries again.
  const lock = tryAcquire([`app:${appId}`], RECONCILER_OP_ID, "reconcile:scale");
  if (!lock.ok) {
    log("converge", `app ${appId}: app:${appId} held by ${lock.heldBy.kind}#${lock.heldBy.opId} — skip`);
    return;
  }
  try {
    const emit: ProgressFn = (step, detail) => log("converge", `app ${appId} [${step}] ${detail}`);
    for (const { serverId, count } of plan.add) {
      const server = db.getServer(serverId)!;
      try {
        await addReplicas(app, server, count, emit);
      } catch (err) {
        emit("scale", `adding replicas on ${server.name} failed, rolling back: ${err}`);
        await rollbackScaleUp(app, replicas, emit);
        throw err;
      }
    }
    if (plan.removeSurplus.length > 0) await removeReplicas(app, plan.removeSurplus, emit);
    if (plan.removeUnplaced.length > 0) {
      if (placementSatisfied(appId, placement)) {
        await removeReplicas(app, plan.removeUnplaced, emit);
      } else {
        emit("scale", "keeping replicas outside the placement until every placed server is healthy");
      }
    }
    log("converge", `app ${appId}: converged toward placement ${JSON.stringify(placement)}`);
  } catch (err) {
    log("converge", `app ${appId}: convergence failed: ${err}`);
  } finally {
    release([`app:${appId}`]);
  }
}
