import { useTempDataDir } from "./test-helpers.ts";
useTempDataDir();

import { expect, test } from "bun:test";
import { enqueueOperation, markOperationFinished } from "./db/operations.ts";
import { serverGcProtections } from "./gc-protection.ts";

test("host GC retains snapshots for operations with incomplete compensation", () => {
  const op = enqueueOperation({ kind: "redeploy", resourceKeys: ["app:42"], input: {}, trigger: "test" });
  markOperationFinished(op.id, "compensation_failed", { message: "rollback failed" });
  expect(serverGcProtections(99999).activeOperationIds).toContain(op.id);
});
