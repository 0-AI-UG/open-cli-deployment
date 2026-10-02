import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, spyOn } from "bun:test";

// destroy-app imports hosts and ingress at module scope — stub them so the op
// can be loaded in-process.
const sshExecMock = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
mock.module("../../shared/remote/index.ts", () => ({
  sshExec: sshExecMock,
  removeContainer: mock(async () => {}),
}));
mock.module("../scale/traefik-manager.ts", () => ({ syncAllTraefik: mock(async () => {}) }));

import * as db from "../../shared/db.ts";
import { enqueueOperation } from "../../shared/db/operations.ts";
import destroyAppOp from "./destroy-app.ts";
import type { OpContext } from "../types.ts";

type Input = { appId: number };

function makeCtx(input: Input, opId: number): OpContext<Input> {
  return {
    opId,
    kind: "destroy_app",
    input,
    trigger: "test",
    triggeredBy: "tester",
    parentId: null,
    attempt: 1,
    isCancelRequested: () => false,
    log: () => {},
    park: () => {},
    unpark: () => {},
  };
}

function seedApp(name: string) {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
  });
}

function parentOp(appId: number) {
  return enqueueOperation({
    kind: "destroy_app",
    resourceKeys: [`app:${appId}`],
    input: { appId },
    trigger: "test",
  });
}

describe("destructive DB cleanup gates", () => {
  test("a failed app directory removal blocks DB deletion", async () => {
    const suffix = randomSuffix();
    const app = seedApp(`dir-fail-${suffix}`);
    const server = db.insertServer({
      name: `dir-host-${suffix}`, provider_id: suffix, ipv4: "203.0.113.43",
      ipv6: "", type: "cx23", location: "fsn1", status: "ready",
    });
    db.insertReplica({ app_id: app.id, server_id: server.id, host_port: 10042, container_name: app.name, status: "running" });
    const parent = parentOp(app.id);
    sshExecMock.mockImplementationOnce(async () => ({ exitCode: 1, stdout: "", stderr: "permission denied" }));
    const stop = destroyAppOp.steps.find((s) => s.name === "stop_and_remove_containers")!;
    const output = await stop.run(makeCtx({ appId: app.id }, parent.id), {}) as { failed: boolean };
    expect(output.failed).toBe(true);
  });

  test("reports the resource failure that blocked DB cleanup", async () => {
    const gate = destroyAppOp.steps.find((s) => s.name === "assert_db_cleanup")!;
    const ctx = makeCtx({ appId: 0 }, 0);
    await expect(gate.run(ctx, {
      delete_volume: { ok: false, error: "Hetzner API token not configured" },
      delete_db_rows: { ok: false, failed: true, failedSteps: ["delete_volume"] },
    })).rejects.toThrow("delete_volume: Hetzner API token not configured");
  });

  test("destroy_app records a DB deletion failure and the final gate rejects success", async () => {
    const app = seedApp(`db-fail-${randomSuffix()}`);
    const parent = parentOp(app.id);
    const ctx = makeCtx({ appId: app.id }, parent.id);
    const deleteRows = destroyAppOp.steps.find((s) => s.name === "delete_db_rows")!;
    const gate = destroyAppOp.steps.find((s) => s.name === "assert_db_cleanup")!;
    const deleteSpy = spyOn(db, "deleteApp").mockImplementationOnce(() => {
      throw new Error("sqlite busy");
    });
    try {
      const output = await deleteRows.run(ctx, {});
      expect(output).toMatchObject({ ok: false, failed: true });
      expect(db.getApp(app.id)?.status).toBe("cleanup_failed");
      await expect(gate.run(ctx, { delete_db_rows: output })).rejects.toThrow(/cleanup incomplete/i);
    } finally {
      deleteSpy.mockRestore();
    }
  });

});
