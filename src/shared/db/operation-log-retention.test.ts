import { useTempDataDir } from "../test-helpers.ts";
useTempDataDir();

import { expect, test } from "bun:test";
import db from "../db.ts";
import { enqueueOperation, markOperationFinished, pruneOldOperationLogs } from "./operations.ts";

function operationWithLogs(finishedDaysAgo: number | null, lines: number): number {
  const op = enqueueOperation({ kind: "deploy_stack", resourceKeys: [`stack:${crypto.randomUUID()}`], input: {}, trigger: "test" });
  if (finishedDaysAgo !== null) {
    markOperationFinished(op.id, "done", null);
    db.query("UPDATE operations SET finished_at = datetime('now', ?) WHERE id = ?").run(`-${finishedDaysAgo} days`, op.id);
  }
  const insert = db.query("INSERT INTO operation_logs (op_id, level, message) VALUES (?, 'info', 'line')");
  for (let i = 0; i < lines; i++) insert.run(op.id);
  return op.id;
}
const logCount = (opId: number) => (db.query("SELECT count(*) AS n FROM operation_logs WHERE op_id = ?").get(opId) as { n: number }).n;

test("prunes logs of long-finished operations in batches and keeps recent or running ones", () => {
  const old = operationWithLogs(20, 5);
  const recent = operationWithLogs(2, 3);
  const running = operationWithLogs(null, 4);
  const retention = 14 * 24 * 60 * 60;

  expect(pruneOldOperationLogs(retention, 3)).toBe(3);
  expect(logCount(old)).toBe(2);
  expect(pruneOldOperationLogs(retention, 3)).toBe(2);
  expect(pruneOldOperationLogs(retention, 3)).toBe(0);
  expect([logCount(old), logCount(recent), logCount(running)]).toEqual([0, 3, 4]);
  expect(db.query("SELECT id FROM operations WHERE id = ?").get(old)).toEqual({ id: old });
});
