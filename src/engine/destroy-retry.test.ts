import { expect, test } from "bun:test";
import { destroyRetryDelayMs } from "./destroy-retry.ts";

test("destroy finalizer delays repeated failures and releases the retry after backoff", () => {
  const now = Date.parse("2026-09-26T12:00:30Z");
  const failed = { status: "failed" as const, finished_at: "2026-09-26 12:00:00" };
  expect(destroyRetryDelayMs([failed], now)).toBe(30_000);
  expect(destroyRetryDelayMs([failed, failed, failed], now)).toBe(210_000);
  expect(destroyRetryDelayMs([failed], now + 31_000)).toBe(0);
  expect(destroyRetryDelayMs([{ status: "done", finished_at: failed.finished_at }], now)).toBe(0);
});
