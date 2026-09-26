import * as db from "../shared/db.ts";
import { countBuildWaitersAhead, updateExecutingStepDetail } from "../shared/db/operations.ts";
import { BuildWorkerUnavailableError } from "./build-worker.ts";
import { BuildWorkerBusyError, type BuildCoordinator, type BuildWorkerSelection } from "./build-coordinator.ts";
import type { OpContext } from "./types.ts";

export async function withBuildFailover<T>(args: {
  ctx: Pick<OpContext, "opId" | "isCancelRequested" | "log"> & Partial<Pick<OpContext, "park" | "unpark">>;
  coordinator: BuildCoordinator;
  preferredWorkerId?: number | null;
  run: (selection: BuildWorkerSelection) => Promise<T>;
  capacityWaitMs?: number;
  capacityPollMs?: number;
}): Promise<{ value: T; workerId: number }> {
  const excludedWorkerIds: number[] = [];
  const deadline = Date.now() + (args.capacityWaitMs ?? 10 * 60_000);
  const pollMs = args.capacityPollMs ?? 2_000;
  let failoverAttempts = 0;
  let parked = false;
  let lastWaitDetail = "";
  try {
    while (true) {
      if (args.ctx.isCancelRequested()) throw new Error("Operation cancelled while waiting for a build worker");
      const ahead = countBuildWaitersAhead(args.ctx.opId);
      if (ahead > 0) {
        waitForCapacity(ahead);
        await pause(ahead);
        continue;
      }
      try {
        return await args.coordinator.withWorker({
          operationId: args.ctx.opId,
          preferredWorkerId: args.preferredWorkerId,
          excludedWorkerIds,
          run: async (selection) => {
            if (parked) { args.ctx.unpark?.(); parked = false; }
            updateExecutingStepDetail(args.ctx.opId, `Building on worker #${selection.workerId}`);
            return args.run(selection);
          },
        });
      } catch (error) {
        if (error instanceof BuildWorkerBusyError) {
          waitForCapacity(countBuildWaitersAhead(args.ctx.opId));
          await pause(countBuildWaitersAhead(args.ctx.opId));
          continue;
        }
        const retryable = error instanceof BuildWorkerUnavailableError &&
          error.workerId != null &&
          !args.ctx.isCancelRequested() &&
          db.listBuildArtifacts(args.ctx.opId).length === 0 &&
          failoverAttempts < 1;
        if (!retryable) throw error;
        failoverAttempts++;
        excludedWorkerIds.push(error.workerId!);
        args.ctx.log(`Build worker #${error.workerId} became unavailable; retrying once on another worker`);
      }
    }
  } finally {
    if (parked) args.ctx.unpark?.();
  }

  function waitForCapacity(ahead: number): void {
    if (!parked) { args.ctx.park?.(); parked = true; }
    const detail = `Waiting for build worker${ahead > 0 ? ` (${ahead} ahead)` : ""}`;
    updateExecutingStepDetail(args.ctx.opId, detail);
    if (detail !== lastWaitDetail) { args.ctx.log(detail); lastWaitDetail = detail; }
  }

  async function pause(ahead: number): Promise<void> {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for an available OCD build worker");
    const waitMs = Math.min(30_000, pollMs * Math.max(1, ahead));
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, Math.max(1, deadline - Date.now()))));
  }
}
