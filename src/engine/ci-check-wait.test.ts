import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();
import { expect, mock, test } from "bun:test";
let runs: unknown[] = [];
mock.module("./ci-github.ts", () => ({ ciInstallationToken: async () => "token", ciRepositoryFromUrl: () => "acme/api", githubCiRequest: async () => ({ check_runs: runs }) }));
import * as db from "../shared/db.ts";
import connection from "../shared/db/connection.ts";
import { enqueueOperation } from "../shared/db/operations.ts";
import { waitForCiChecks } from "./ci-checks.ts";
import type { OpContext } from "./types.ts";
function context() {
  const name = randomSuffix();
  const server = db.insertServer({ name, provider_id: name, ipv4: "203.0.113.81", ipv6: "", type: "cx23", location: "nbg1", status: "ready" });
  const worker = db.insertBuildWorker({ serverId: server.id, name });
  const source = db.upsertBuildSource({ repository: `https://github.com/acme/${name}`, branch: "main", workerId: worker.id });
  const op = enqueueOperation({ kind: "webhook_build_source", resourceKeys: [], input: {}, trigger: "test" });
  db.setCiCheckPolicy(source.id, { checks: [{ name: "test", app_id: 123 }], timeout_seconds: 60 });
  const ctx: OpContext<{ sourceId: number; commit: string; deliveryId: string }> = { opId: op.id, kind: op.kind, input: { sourceId: source.id, commit: "a".repeat(40), deliveryId: "test" }, trigger: "test", triggeredBy: "", parentId: null, attempt: 1, isCancelRequested: () => false, log: mock(() => {}), park: mock(() => {}), unpark: mock(() => {}) };
  return ctx;
}
test("a missing check times out against durable enqueue time and returns the engine slot", async () => {
  const ctx = context(); runs = [];
  connection.query("UPDATE operations SET enqueued_at=datetime('now','-2 minutes') WHERE id=?").run(ctx.opId);
  await expect(waitForCiChecks(ctx, () => {})).rejects.toThrow("Timed out");
  expect(ctx.park).toHaveBeenCalledTimes(1); expect(ctx.unpark).toHaveBeenCalledTimes(1);
});
test("a superseded delivery cannot pass even when GitHub returns success", async () => {
  const ctx = context(); runs = [{ id: 1, name: "test", head_sha: ctx.input.commit, app: { id: 123 }, status: "completed", conclusion: "success" }];
  let calls = 0;
  await expect(waitForCiChecks(ctx, () => { if (++calls === 2) throw new Error("superseded"); })).rejects.toThrow("superseded");
  expect(ctx.unpark).toHaveBeenCalledTimes(1);
});
