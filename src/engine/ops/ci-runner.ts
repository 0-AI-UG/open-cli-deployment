import * as db from "../../shared/db.ts";
import { sshExec } from "../../shared/remote/index.ts";
import { assertCiServerAvailable, ciInstallScript, removeCiRunnerFiles, releaseCiHost, syncCiRunner } from "../ci-runner.ts";
import { registerOp } from "./registry.ts";
import type { OpKindDefinition } from "../types.ts";

type Input = { runnerId: number };
const keys = ({ runnerId }: Input) => {
  const runner = db.getCiRunner(runnerId);
  return [`ci-runner:${runnerId}`, ...(runner ? [`server:${runner.server_id}`] : [])];
};
const install: OpKindDefinition<Input> = {
  kind: "install_ci_runner", label: "Install CI runner", resourceKeys: keys,
  steps: [{ name: "install", async run(ctx) {
    const runner = db.getCiRunner(ctx.input.runnerId);
    if (!runner) throw new Error("CI runner not found");
    assertCiServerAvailable(runner.server_id, !!runner.shared_builds);
    ctx.park();
    try {
      while (!db.tryReserveCiHost(runner.id)) {
        if (ctx.isCancelRequested()) throw new Error("CI installation cancelled while waiting for the build host");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally { ctx.unpark(); }
    const server = db.getServer(runner.server_id)!;
    const result = await sshExec(server.ipv4, ciInstallScript(!!runner.shared_builds, runner.job_timeout_seconds), server.ssh_host_key || undefined);
    if (result.exitCode !== 0) {
      db.updateCiRunner(runner.id, { status: "error", last_error: "CI dependency installation failed" });
      throw new Error("CI dependency installation failed");
    }
    await releaseCiHost(db.getCiRunner(runner.id)!);
    db.updateCiRunner(runner.id, { status: "starting" });
    return { ok: true };
  } }, { name: "start", async run(ctx) { await syncCiRunner(ctx.input.runnerId); return { ok: true }; } }],
};
const sync: OpKindDefinition<Input> = {
  kind: "sync_ci_runner", label: "Reconcile CI runner", resourceKeys: keys,
  steps: [{ name: "sync", async run(ctx) {
    try { await syncCiRunner(ctx.input.runnerId); }
    catch (error) {
      db.updateCiRunner(ctx.input.runnerId, { status: db.getCiRunner(ctx.input.runnerId)?.draining ? "draining" : "error", last_error: error instanceof Error ? error.message : "CI reconciliation failed", last_checked_at: new Date().toISOString() });
      throw error;
    }
    return { ok: true };
  } }],
};
const remove: OpKindDefinition<Input> = {
  kind: "remove_ci_runner", label: "Remove CI runner", resourceKeys: keys,
  steps: [{ name: "remove", async run(ctx) {
    if (!db.getCiRunner(ctx.input.runnerId)) return { ok: true };
    db.updateCiRunner(ctx.input.runnerId, { draining: 1 });
    await syncCiRunner(ctx.input.runnerId);
    await removeCiRunnerFiles(ctx.input.runnerId);
    return { ok: true };
  } }],
};
for (const definition of [install, sync, remove]) registerOp(definition);
