import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();
import { expect, test } from "bun:test";
import * as db from "../db.ts";
import connection from "./connection.ts";
import { initializeCiSchema } from "./ci-schema.ts";
import { Database } from "bun:sqlite";
import { assertPlacementUsable } from "../app-config.ts";
function server() {
  const suffix = randomSuffix();
  return db.insertServer({ name: `ci-${suffix}`, provider_id: suffix, ipv4: "203.0.113.50", ipv6: "", type: "cx23", location: "nbg1", status: "ready" });
}
test("CI reserves exactly one runner per host and prevents app placement and host deletion", () => {
  const host = server();
  const runner = db.insertCiRunner(host.id, `ci-${randomSuffix()}`, "acme/api");
  expect(db.getCiRunnerByServerId(host.id)?.id).toBe(runner.id);
  expect(() => db.insertCiRunner(host.id, `ci-${randomSuffix()}`, "acme/api")).toThrow();
  expect(() => assertPlacementUsable({ [host.id]: 1 })).toThrow("dedicated CI runner");
  expect(() => db.deleteServer(host.id)).toThrow();
  db.updateCiRunner(runner.id, { draining: 1, status: "drained", github_runner_id: 123 });
  expect(db.getCiRunner(runner.id)?.draining).toBe(1);
  db.deleteCiRunner(runner.id);
  expect(db.getServer(host.id)).not.toBeNull();
  expect(() => assertPlacementUsable({ [host.id]: 1 })).not.toThrow();
});
test("check policies survive source updates", () => {
  const host = server();
  const worker = db.insertBuildWorker({ serverId: host.id, name: `build-${randomSuffix()}` });
  const source = db.upsertBuildSource({ repository: `https://github.com/acme/${randomSuffix()}.git`, branch: "main", workerId: worker.id });
  const policy = { checks: [{ name: "test", app_id: 123 }], timeout_seconds: 120 };
  db.setCiCheckPolicy(source.id, policy);
  db.upsertBuildSource({ repository: source.repository, branch: source.branch, workerId: worker.id });
  expect(db.getCiCheckPolicy(source.id)).toEqual(policy);
  db.setCiCheckPolicy(source.id, { checks: [], timeout_seconds: 60 });
  expect(db.getCiCheckPolicy(source.id)?.checks).toEqual([]);
});
test("migration schema matches fresh CI tables", () => {
  const migrated = new Database(":memory:");
  initializeCiSchema(migrated);
  for (const name of ["ci_runners", "ci_check_policies"]) {
    expect(migrated.query(`PRAGMA table_info(${name})`).all()).toEqual(connection.query(`PRAGMA table_info(${name})`).all());
  }
  migrated.close();
});

test("shared CI and builds acquire the same host atomically and retain the CI fence through restart", () => {
  const host = server();
  const worker = db.insertBuildWorker({ serverId: host.id, name: `build-${randomSuffix()}` });
  db.updateBuildWorker(worker.id, { status: "online", architecture: "x86_64", disk_free_bytes: 30 * 1024 ** 3, last_checked_at: new Date().toISOString() });
  const ci = db.insertCiRunner(host.id, `ci-${randomSuffix()}`, "acme/api", undefined, true);
  const { enqueueOperation } = require("./operations.ts");
  const op = enqueueOperation({ kind: "build_test", resourceKeys: [], input: {}, trigger: "test" });
  const first = db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [worker.id] })!;
  expect(first).not.toBeNull(); expect(db.tryReserveCiHost(ci.id)).toBe(false);
  db.releaseBuildWorkerLease({ operationId: op.id, leaseToken: first.lease_token });
  expect(db.tryReserveCiHost(ci.id)).toBe(true);
  expect(db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [worker.id] })).toBeNull();
  connection.query("UPDATE ci_runners SET last_checked_at=datetime('now','-1 day') WHERE id=?").run(ci.id);
  expect(db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [worker.id] })).toBeNull();
  db.updateCiRunner(ci.id, { host_reserved: 0 });
  expect(db.tryAcquireBuildWorkerLease({ operationId: op.id, candidateWorkerIds: [worker.id] })).not.toBeNull();
});

test("waiting builds block new CI admission; a delivery awaiting CI checks does not", () => {
  const host = server(); const worker = db.insertBuildWorker({ serverId: host.id, name: `b-${randomSuffix()}` });
  db.updateBuildWorker(worker.id, { status: "online" });
  const ci = db.insertCiRunner(host.id, `ci-${randomSuffix()}`, "acme/api", undefined, true);
  const { enqueueOperation, insertStep, markOperationRunning, updateExecutingStepDetail } = require("./operations.ts");
  const op = enqueueOperation({ kind: "webhook_build_source", resourceKeys: [], input: {}, trigger: "test" });
  markOperationRunning(op.id);
  insertStep({ opId: op.id, seq: 1, step: "build_images", phase: "forward", status: "executing", detail: "Waiting for CI checks" });
  expect(db.tryReserveCiHost(ci.id)).toBe(true);
  db.updateCiRunner(ci.id, { host_reserved: 0 });
  updateExecutingStepDetail(op.id, "Waiting for build worker");
  expect(db.tryReserveCiHost(ci.id)).toBe(false);
});
