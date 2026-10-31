import * as db from "../shared/db.ts";
import { enqueueOperation, listPendingOperations, listRunningOperations } from "../shared/db/operations.ts";
import { observeCiRunner } from "./ci-runner.ts";

let timer: ReturnType<typeof setInterval> | undefined;
let observing = false;
export async function reconcileCiRunners(): Promise<void> {
  if (observing) return;
  observing = true;
  try {
    const active = [...listPendingOperations(100000), ...listRunningOperations()];
    await Promise.all(db.getCiRunners().map(async runner => {
      if (runner.status === "installing" || runner.status === "drained") return;
      if (runner.shared_builds && runner.status === "idle" && runner.last_checked_at && Date.now() - Date.parse(runner.last_checked_at) < 60_000) return;
      if (active.some(op => op.kind.endsWith("ci_runner") && JSON.parse(op.input_json).runnerId === runner.id)) return;
      try {
        // Healthy runners only need observations, not an operation every poll.
        if (!await observeCiRunner(runner.id)) return;
        enqueueOperation({ kind: "sync_ci_runner", resourceKeys: [`ci-runner:${runner.id}`, `server:${runner.server_id}`], input: { runnerId: runner.id }, trigger: "system" });
      } catch (error) {
        db.updateCiRunner(runner.id, { status: db.getCiRunner(runner.id)?.draining ? "draining" : "error", last_error: error instanceof Error ? error.message : "CI health check failed", last_checked_at: new Date().toISOString() });
      }
    }));
  } finally { observing = false; }
}
export function startCiController(): void {
  if (timer) return;
  const tick = () => { void reconcileCiRunners().catch(error => console.error("CI controller:", error)); };
  tick();
  timer = setInterval(tick, 30_000);
}
export function stopCiController(): void { if (timer) clearInterval(timer); timer = undefined; }
