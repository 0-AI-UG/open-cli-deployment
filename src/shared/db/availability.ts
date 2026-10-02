import db from "./connection.ts";
import { getReplicas } from "./replicas.ts";
import { parsePlacement, placementTotal } from "../placement.ts";

// --- App availability samples ---
// Periodic snapshots of whether an app ran its declared placement,
// used to compute uptime% and MTTR (mean time to recovery). One row per
// reconciler evaluation; pruned on a retention window like the metrics tables.

export type AvailabilitySampleRow = {
  id: number;
  app_id: number;
  meets_target: number;
  desired_count: number;
  running_count: number;
  sampled_at: string;
};

/**
 * Shared availability-target predicate: an app meets its target when every
 * placed server runs its declared number of healthy replicas. Lives here so
 * the reconciler's sampler and the availability route agree.
 */
export function computeMeetsTarget(p: {
  /** Declared placement: server id -> replica count. */
  placement: Record<string, number>;
  /** Running replicas per server id. */
  running_by_server: Map<number, number>;
}): boolean {
  const entries = Object.entries(p.placement);
  return entries.length > 0 &&
    entries.every(([serverId, count]) => (p.running_by_server.get(Number(serverId)) ?? 0) >= count);
}

/** Live availability snapshot: running replicas against the declared placement. */
export function currentAvailability(app: { id: number; placement: string | null }): {
  desired: number;
  running: number;
  meetsTarget: boolean;
} {
  const placement = parsePlacement(app.placement);
  const running = getReplicas(app.id).filter((replica) => replica.status === "running");
  const runningByServer = new Map<number, number>();
  for (const replica of running) {
    runningByServer.set(replica.server_id, (runningByServer.get(replica.server_id) ?? 0) + 1);
  }
  return {
    desired: placementTotal(placement),
    running: running.length,
    meetsTarget: computeMeetsTarget({ placement, running_by_server: runningByServer }),
  };
}

export function insertAvailabilitySample(s: {
  app_id: number;
  meets_target: boolean;
  desired_count: number;
  running_count: number;
}): void {
  db.query(
    "INSERT INTO availability_samples (app_id, meets_target, desired_count, running_count) VALUES (?, ?, ?, ?)"
  ).run(
    s.app_id,
    s.meets_target ? 1 : 0,
    s.desired_count,
    s.running_count,
  );
}

/**
 * Availability summary for an app over the trailing `sinceSeconds` window.
 *  - uptimePct: 100 * (samples meeting target) / total samples; 0 when no samples.
 *  - mttrSeconds: mean duration of downtime runs — each maximal span of
 *    consecutive meets_target=0 samples, measured from the sampled_at of the
 *    first failing sample to the sampled_at of the next passing sample. null when
 *    there were no recovered outages (never failed, or still down at window end).
 *  - sampleCount: number of samples in the window.
 *  - lastMeetsTarget: meets_target of the newest sample (null when no samples).
 */
export function getAvailabilityStats(
  appId: number,
  sinceSeconds: number,
): { uptimePct: number; mttrSeconds: number | null; sampleCount: number; lastMeetsTarget: boolean | null } {
  const rows = db
    .query(
      `SELECT meets_target, sampled_at
       FROM availability_samples
       WHERE app_id = ? AND sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`,
    )
    .all(appId, `-${sinceSeconds} seconds`) as Array<{ meets_target: number; sampled_at: string }>;

  const sampleCount = rows.length;
  if (sampleCount === 0) {
    return { uptimePct: 0, mttrSeconds: null, sampleCount: 0, lastMeetsTarget: null };
  }

  const meetsCount = rows.reduce((acc, r) => acc + (r.meets_target ? 1 : 0), 0);
  const uptimePct = 100 * (meetsCount / sampleCount);

  // Walk the ordered samples, collecting the duration of each downtime run that
  // recovered (a passing sample follows a failing run). A run still open at the
  // end of the window is not counted (no recovery observed yet).
  const recoveryDurations: number[] = [];
  let outageStart: number | null = null;
  for (const r of rows) {
    const t = Date.parse(r.sampled_at + "Z"); // sampled_at is a UTC datetime('now') string
    if (!r.meets_target) {
      if (outageStart === null) outageStart = t;
    } else if (outageStart !== null) {
      recoveryDurations.push((t - outageStart) / 1000);
      outageStart = null;
    }
  }

  const mttrSeconds =
    recoveryDurations.length > 0
      ? recoveryDurations.reduce((a, b) => a + b, 0) / recoveryDurations.length
      : null;

  const lastMeetsTarget = rows[rows.length - 1].meets_target === 1;

  return { uptimePct, mttrSeconds, sampleCount, lastMeetsTarget };
}

export function pruneOldAvailabilitySamples(olderThanSeconds: number): void {
  db.query(
    "DELETE FROM availability_samples WHERE sampled_at < datetime('now', ?)"
  ).run(`-${olderThanSeconds} seconds`);
}
