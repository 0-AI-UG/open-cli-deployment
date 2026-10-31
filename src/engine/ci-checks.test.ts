import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();
import { describe, expect, test } from "bun:test";
import { evaluateCiChecks, type CiCheckRun } from "./ci-checks.ts";
const sha = "a".repeat(40);
const policy = [{ name: "test", app_id: 15368 }];
const run = (fields: Partial<CiCheckRun> = {}): CiCheckRun => ({ id: 1, name: "test", head_sha: sha, app: { id: 15368 }, status: "completed", conclusion: "success", ...fields });
describe("deployment CI check gate", () => {
  test("requires exact commit, name, and provider", () => {
    expect(evaluateCiChecks(policy, [run()], sha).ready).toBe(true);
    for (const fields of [{ head_sha: "b".repeat(40) }, { name: "different" }, { app: { id: 7 } }, { app: null }]) {
      expect(evaluateCiChecks(policy, [run(fields)], sha)).toEqual({ ready: false, pending: ["test"] });
    }
  });
  test("a newer retry supersedes an older successful run", () => {
    expect(evaluateCiChecks(policy, [run(), run({ id: 2, status: "in_progress", conclusion: null })], sha).ready).toBe(false);
    expect(() => evaluateCiChecks(policy, [run(), run({ id: 2, conclusion: "failure" })], sha)).toThrow("failure");
    expect(evaluateCiChecks(policy, [run({ conclusion: "failure" }), run({ id: 2 })], sha).ready).toBe(true);
  });
  test("skipped, neutral, cancelled, and timed-out checks do not authorize deployment", () => {
    for (const conclusion of ["skipped", "neutral", "cancelled", "timed_out", null]) expect(() => evaluateCiChecks(policy, [run({ conclusion })], sha)).toThrow();
  });
});
