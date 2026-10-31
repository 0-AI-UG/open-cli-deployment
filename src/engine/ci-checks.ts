import { getOperation } from "../shared/db/operations.ts";
import * as db from "../shared/db.ts";
import type { OpContext } from "./types.ts";
import { ciInstallationToken, ciRepositoryFromUrl, githubCiRequest } from "./ci-github.ts";

export type CiCheckRun = { id: number; name: string; head_sha: string; status: string; conclusion: string | null; app: { id: number } | null };
export function evaluateCiChecks(checks: db.RequiredCiCheck[], runs: CiCheckRun[], commit: string): { ready: boolean; pending: string[] } {
  const pending: string[] = [];
  for (const check of checks) {
    const run = runs.filter(run => run.head_sha === commit && run.name === check.name && run.app?.id === check.app_id).sort((a, b) => b.id - a.id)[0];
    if (!run || run.status !== "completed") { pending.push(check.name); continue; }
    if (run.conclusion !== "success") throw new Error(`Required CI check ${check.name} concluded ${run.conclusion || "unknown"}`);
  }
  return { ready: pending.length === 0, pending };
}
export async function readCiCheckRuns(repository: string, commit: string, token: string): Promise<CiCheckRun[]> {
  const runs: CiCheckRun[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await githubCiRequest<{ check_runs: CiCheckRun[] }>(`/repos/${repository}/commits/${commit}/check-runs?filter=all&per_page=100&page=${page}`, token);
    runs.push(...result.check_runs);
    if (result.check_runs.length < 100) return runs;
  }
  throw new Error("Too many CI checks to verify safely");
}
export async function waitForCiChecks(ctx: OpContext<{ sourceId: number; commit: string; deliveryId: string }>, assertFresh: () => void): Promise<void> {
  const policy = db.getCiCheckPolicy(ctx.input.sourceId);
  if (!policy?.checks.length) return;
  const source = db.getBuildSource(ctx.input.sourceId);
  if (!source) throw new Error("Build source not found");
  const repository = ciRepositoryFromUrl(source.repository);
  // Anchor to the durable operation creation time, including across engine restarts.
  const operation = getOperation(ctx.opId);
  const started = operation ? Date.parse(operation.enqueued_at.replace(" ", "T") + (operation.enqueued_at.endsWith("Z") ? "" : "Z")) : Date.now();
  const deadline = started + policy.timeout_seconds * 1000;
  let lastPending = "";
  ctx.park();
  try {
    while (true) {
      assertFresh();
      // Mint a fresh token each poll; waits can outlive installation tokens.
      const token = await ciInstallationToken(repository);
      const result = evaluateCiChecks(policy.checks, await readCiCheckRuns(repository, ctx.input.commit, token), ctx.input.commit);
      assertFresh();
      if (result.ready) { ctx.log("Required CI checks passed for the exact delivery commit"); return; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for CI checks: ${result.pending.join(", ")}`);
      const pending = result.pending.join(", ");
      if (pending !== lastPending) { ctx.log(`Waiting for CI checks: ${pending}`); lastPending = pending; }
      // Cancellation/supersession remains responsive throughout the polling interval.
      for (let i = 0; i < 15; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        assertFresh();
      }
    }
  } finally { ctx.unpark(); }
}
