import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();
import { expect, mock, test } from "bun:test";
mock.module("./ci-runner.ts", () => ({ observeCiRunner: async () => true }));
import * as db from "../shared/db.ts";
import { listPendingOperations, markOperationFinished } from "../shared/db/operations.ts";
import { reconcileCiRunners } from "./ci-controller.ts";
function runner() {
  const name = randomSuffix();
  const server = db.insertServer({ name, provider_id: name, ipv4: "203.0.113.80", ipv6: "", type: "cx23", location: "nbg1", status: "ready" });
  return db.insertCiRunner(server.id, `ci-${name}`, "acme/api");
}
test("controller avoids installing/drained runners and schedules only one outstanding sync per server", async () => {
  const row = runner(); await reconcileCiRunners();
  expect(listPendingOperations()).toHaveLength(0);
  db.updateCiRunner(row.id, { status: "online" });
  await reconcileCiRunners(); await reconcileCiRunners();
  expect(listPendingOperations()).toHaveLength(1);
  const operation = listPendingOperations()[0]!;
  expect(JSON.parse(operation.resource_keys)).toContain(`server:${row.server_id}`);
  markOperationFinished(operation.id, "done");
  db.updateCiRunner(row.id, { status: "drained", draining: 1 });
  await reconcileCiRunners(); expect(listPendingOperations()).toHaveLength(0);
});
