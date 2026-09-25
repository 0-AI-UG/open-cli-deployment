import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, mock, test } from "bun:test";
import * as db from "../shared/db.ts";
import { cleanAfterBuild, preflightRolloutSpace } from "./rollout-gc.ts";
import type { garbageCollectServer } from "../shared/remote/index.ts";

function placedApp() {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `gc-${suffix}`, provider_id: `gc-${suffix}`, ipv4: "203.0.113.40",
    ipv6: "", type: "cx23", location: "nbg1", status: "ready",
  });
  const app = db.insertApp({
    name: `app-${suffix}`, domain: "", image_ref: "registry.example.com/app@sha256:" + "a".repeat(64),
    container_port: 3000, env_vars: JSON.stringify({ env: {}, outputs: {} }),
  });
  db.insertReplica({ app_id: app.id, server_id: server.id, container_name: `${app.name}-r1`, host_port: 40001, status: "running" });
  return { server, app };
}

function collected() {
  return { reclaimed_bytes: 6 * 1024 ** 3 } as Awaited<ReturnType<typeof garbageCollectServer>>;
}

describe("automatic rollout GC", () => {
  test("cleans once and rechecks a low-space host before the build", async () => {
    const { server, app } = placedApp();
    const checkSpace = mock(async (_ip: string, _hostKey?: string) => 8 * 1024 ** 3)
      .mockRejectedValueOnce(new Error("Insufficient Docker disk space on 203.0.113.40"))
      .mockResolvedValueOnce(8 * 1024 ** 3);
    const collect = mock(async (_ip: string, _hostKey?: string, _opts?: Parameters<typeof garbageCollectServer>[2]) => collected());
    const messages: string[] = [];

    await preflightRolloutSpace([app.name], (message) => messages.push(message), { checkSpace, collect });

    expect(checkSpace).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]![0]).toBe(server.ipv4);
    expect(collect.mock.calls[0]![2]?.activeAppNames).toContain(app.name);
    expect(messages.join(" ")).toContain("Low Docker disk space");
  });

  test("deduplicates hosts and reports post-deploy cleanup errors without failing delivery", async () => {
    const { app } = placedApp();
    const collect = mock(async () => { throw new Error("host unavailable"); });
    const messages: string[] = [];

    await cleanAfterBuild([app.name, app.name], (message) => messages.push(message), {
      checkSpace: mock(async () => 8 * 1024 ** 3), collect,
    });

    expect(collect).toHaveBeenCalledTimes(1);
    expect(messages.join(" ")).toContain("host unavailable");
  });
});
