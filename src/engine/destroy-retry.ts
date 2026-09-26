import type { OperationRow } from "../shared/db/operations.ts";

/** Back off repeated finalizer failures while retaining the app as a recovery anchor. */
export function destroyRetryDelayMs(attempts: Pick<OperationRow, "status" | "finished_at">[], now = Date.now()): number {
  const latest = attempts[0];
  if (!latest || latest.status === "done" || !latest.finished_at) return 0;
  const streak = attempts.findIndex((attempt) => attempt.status === "done");
  const failures = streak < 0 ? attempts.length : streak;
  const interval = Math.min(60_000 * 2 ** Math.max(0, failures - 1), 60 * 60_000);
  const finishedAt = Date.parse(latest.finished_at.replace(" ", "T") + "Z");
  return Number.isFinite(finishedAt) ? Math.max(0, finishedAt + interval - now) : 0;
}
