// Set a unique tmp data dir BEFORE importing db.ts so the test runs against
// an isolated database, not the user's real ~/.ocp/deploy.db.
import { tmpdir } from "os";
import { mkdtempSync } from "fs";
import path from "path";
process.env.OCD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "ocd-convergence-test-"));

import { describe, test, expect } from "bun:test";

// Every DB-backed case below is one where convergence must decide to do
// nothing, so it never reaches SSH. No network mocks are installed: mock.module
// is process-global in Bun and would leak into sibling test files.
import * as db from "../../shared/db.ts";
import type { ReplicaRow } from "../../shared/db.ts";
import { convergeAppReplicas, planConvergence } from "./convergence.ts";

let seq = 0;
function freshServer(status = "ready") {
  seq++;
  return db.insertServer({
    name: `srv-${seq}-${Date.now()}`,
    provider_id: `h-${seq}-${Date.now()}-${Math.random()}`,
    ipv4: "1.2.3.4",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status,
  });
}

function freshApp(placement: Record<string, number>): db.AppRow {
  seq++;
  const app = db.insertApp({
    name: `app-${seq}-${Date.now()}`,
    domain: "",
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    placement,
  });
  db.updateAppStatus(app.id, "running");
  return db.getApp(app.id)!;
}

function replica(appId: number, serverId: number, status = "running"): ReplicaRow {
  seq++;
  return db.insertReplica({
    app_id: appId,
    server_id: serverId,
    host_port: 10000 + seq,
    container_name: `c-${seq}`,
    status,
  });
}

const row = (id: number, serverId: number, status = "running", created = "2026-01-01 00:00:00") =>
  ({ id, server_id: serverId, status, created_at: created }) as ReplicaRow;

describe("planConvergence", () => {
  const ready = () => "ready";

  test("adds the missing replicas per placed server", () => {
    const plan = planConvergence({ "1": 2, "2": 1 }, [row(10, 1)], ready);
    expect(plan.add).toEqual([{ serverId: 1, count: 1 }, { serverId: 2, count: 1 }]);
    expect(plan.removeSurplus).toEqual([]);
    expect(plan.removeUnplaced).toEqual([]);
  });

  test("removes surplus on a placed server, unhealthy first", () => {
    const plan = planConvergence(
      { "1": 1 },
      [row(10, 1, "running", "2026-01-02 00:00:00"), row(11, 1, "unhealthy", "2026-01-01 00:00:00")],
      ready,
    );
    expect(plan.add).toEqual([]);
    expect(plan.removeSurplus.map((r) => r.id)).toEqual([11]);
  });

  test("replicas outside the placement are scheduled for removal", () => {
    const plan = planConvergence({ "1": 1 }, [row(10, 1), row(11, 3)], ready);
    expect(plan.removeUnplaced.map((r) => r.id)).toEqual([11]);
  });

  test("an unavailable placed server is left alone and never compensated elsewhere", () => {
    const status = (id: number) => id === 2 ? "unavailable" : "ready";
    const plan = planConvergence({ "1": 1, "2": 2 }, [row(10, 1), row(11, 2, "unhealthy")], status);
    expect(plan.add).toEqual([]);
    expect(plan.removeSurplus).toEqual([]);
    expect(plan.removeUnplaced).toEqual([]);
    expect(plan.unavailable).toEqual([2]);
  });

  test("an unplaced replica on an unreachable server keeps its row", () => {
    const status = (id: number) => id === 3 ? "unavailable" : "ready";
    const plan = planConvergence({ "1": 1 }, [row(10, 1), row(11, 3)], status);
    expect(plan.removeUnplaced).toEqual([]);
  });
});

describe("convergeAppReplicas", () => {
  test("a matching placement is a no-op", async () => {
    const server = freshServer();
    const app = freshApp({ [String(server.id)]: 1 });
    const only = replica(app.id, server.id);
    await convergeAppReplicas(app.id);
    expect(db.getReplicas(app.id).map((r) => r.id)).toEqual([only.id]);
  });

  test("does not reschedule when the placed server is unavailable", async () => {
    const down = freshServer("unavailable");
    freshServer(); // a ready server OCD must not pick
    const app = freshApp({ [String(down.id)]: 1 });
    const stranded = replica(app.id, down.id, "unhealthy");
    await convergeAppReplicas(app.id);
    const replicas = db.getReplicas(app.id);
    expect(replicas.map((r) => r.id)).toEqual([stranded.id]);
    expect(replicas[0].server_id).toBe(down.id);
  });

  test("keeps replicas outside the placement until the placed ones are healthy", async () => {
    const placed = freshServer();
    const old = freshServer();
    const app = freshApp({ [String(placed.id)]: 1 });
    replica(app.id, placed.id, "unhealthy");
    const previous = replica(app.id, old.id, "running");
    await convergeAppReplicas(app.id);
    expect(db.getReplicas(app.id).some((r) => r.id === previous.id)).toBe(true);
  });

  test("never touches a volume app whose replica is outside its placement", async () => {
    const placed = freshServer();
    const other = freshServer();
    const app = freshApp({ [String(placed.id)]: 1 });
    db.updateAppVolume(app.id, "vol-123", "/mnt/data:/data");
    const current = replica(app.id, other.id);
    await convergeAppReplicas(app.id);
    expect(db.getReplicas(app.id).map((r) => r.id)).toEqual([current.id]);
  });

  test("an app without a declared placement is left alone", async () => {
    const server = freshServer();
    const app = db.insertApp({
      name: `legacy-${Date.now()}`,
      domain: "",
      image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      container_port: 3000,
      env_vars: "{}",
    });
    db.updateAppStatus(app.id, "running");
    replica(app.id, server.id);
    replica(app.id, server.id);
    await convergeAppReplicas(app.id);
    expect(db.getReplicas(app.id)).toHaveLength(2);
  });
});
