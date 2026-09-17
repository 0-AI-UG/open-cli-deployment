import { expect, test } from "bun:test";
import { metricHasRolloutSpace } from "./disk-capacity.ts";

test("placement excludes a host with less than five GiB free", () => {
  expect(metricHasRolloutSpace({ disk_total_gb: 40, disk_used_gb: 36 })).toBe(false);
  expect(metricHasRolloutSpace({ disk_total_gb: 40, disk_used_gb: 34 })).toBe(true);
  expect(metricHasRolloutSpace(undefined)).toBe(true);
});
