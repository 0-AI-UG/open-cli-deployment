import { randomSuffix } from "../../shared/test-helpers.ts";
import { describe, expect, test } from "bun:test";
import * as db from "../../shared/db.ts";
import moveOp, { movedPlacement } from "./move.ts";

function server(status = "ready") {
  return db.insertServer({
    name: `move-${randomSuffix()}`, provider_id: "", ipv4: "198.51.100.50", ipv6: "",
    type: "cx23", location: "nbg1", status,
  });
}

function app(placement: Record<string, number>) {
  return db.insertApp({
    name: `move-app-${randomSuffix()}`,
    domain: "",
    image_ref: `ghcr.io/acme/app@sha256:${"a".repeat(64)}`,
    container_port: 3000,
    env_vars: "{}",
    placement,
  });
}

function ctx(input: { appId: number; fromServerId: number; toServerId: number }) {
  return { opId: 1, input, log: () => {}, isCancelRequested: () => false } as any;
}

const validate = moveOp.steps.find((step) => step.name === "load_and_validate")!;

describe("movedPlacement", () => {
  test("moves the source count onto the target and drops the source", () => {
    expect(movedPlacement({ "5": 1, "15": 1 }, 15, 7)).toEqual({ "5": 1, "7": 1 });
    expect(movedPlacement({ "5": 2, "7": 1 }, 5, 7)).toEqual({ "7": 3 });
  });
});

describe("move validation", () => {
  test("requires the app to be placed on the source server", async () => {
    const [a, b, c] = [server(), server(), server()];
    const moving = app({ [String(a.id)]: 1 });
    await expect(validate.run(ctx({ appId: moving.id, fromServerId: b.id, toServerId: c.id }), {}))
      .rejects.toThrow("is not placed on");
  });

  test("refuses an unusable target", async () => {
    const [a, down, builder] = [server(), server("unavailable"), server()];
    db.insertBuildWorker({ serverId: builder.id, name: `builder-${randomSuffix()}` });
    const moving = app({ [String(a.id)]: 1 });
    await expect(validate.run(ctx({ appId: moving.id, fromServerId: a.id, toServerId: down.id }), {}))
      .rejects.toThrow("not ready");
    await expect(validate.run(ctx({ appId: moving.id, fromServerId: a.id, toServerId: builder.id }), {}))
      .rejects.toThrow("build worker");
  });

  test("reports how many replicas move", async () => {
    const [a, b] = [server(), server()];
    const moving = app({ [String(a.id)]: 2 });
    expect(await validate.run(ctx({ appId: moving.id, fromServerId: a.id, toServerId: b.id }), {}))
      .toEqual({ count: 2, withVolume: false });
  });
});
