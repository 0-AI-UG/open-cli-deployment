import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { expect, mock, test } from "bun:test";

const pullImmutableImage = mock(async () => { throw new Error("registry authentication failed"); });
const startAppReplica = mock(async () => ({}));
mock.module("../../shared/remote/index.ts", () => ({
  pullImmutableImage,
  startAppReplica,
  sshExec: mock(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  removeContainer: mock(async () => {}),
  restartContainer: mock(async () => {}),
  pauseContainer: mock(async () => {}),
  unpauseContainer: mock(async () => {}),
  probeAppHealth: mock(async () => ({ healthy: true })),
}));
mock.module("../scale/traefik-manager.ts", () => ({
  syncAppIngress: mock(async () => {}),
  syncAllTraefik: mock(async () => {}),
}));

const db = await import("../../shared/db.ts");
const { reloadAppEnvironment } = await import("./lifecycle.ts");

test("registry preflight leaves replicas serving when a pull fails", async () => {
  const server = db.insertServer({
    name: `preflight-${randomSuffix()}`, provider_id: randomSuffix(), ipv4: "203.0.113.21",
    ipv6: "", type: "cx23", location: "fsn1", status: "ready",
  });
  const app = db.insertApp({
    name: `preflight-${randomSuffix()}`, domain: "", container_port: 3000,
    env_vars: "{}", image_ref: `ghcr.io/acme/app@sha256:${"a".repeat(64)}`,
  });
  const replica = db.insertReplica({
    app_id: app.id, server_id: server.id, host_port: 10020,
    container_name: app.name, status: "running",
  });
  const result = await reloadAppEnvironment(app.id);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("registry authentication failed");
  expect(startAppReplica).not.toHaveBeenCalled();
  expect(db.getReplica(replica.id)?.status).toBe("running");
});
