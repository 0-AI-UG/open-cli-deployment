import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { beforeEach, describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import connection from "../shared/db/connection.ts";
import { enqueueOperation, getSteps, insertStep, markOperationRunning } from "../shared/db/operations.ts";
import type { ServerRow } from "../shared/db/servers.ts";
import { createBuildCoordinator } from "./build-coordinator.ts";
import { withBuildFailover } from "./build-failover.ts";
import { BuildWorkerUnavailableError } from "./build-worker.ts";
import type { BuildTransport, WorkerObservation } from "./build-transport.ts";

const HEALTHY_DISK_BYTES = 30 * 1024 ** 3;

function operation() {
  return enqueueOperation({
    kind: "test_coordinated_build",
    resourceKeys: [],
    input: {},
    trigger: "test",
  });
}

function worker(name: string) {
  const suffix = randomSuffix();
  const server = db.insertServer({
    name: `${name}-${suffix}`,
    provider_id: `${name}-${suffix}`,
    ipv4: "203.0.113.50",
    ipv6: "",
    type: "cx23",
    location: "nbg1",
    status: "ready",
  });
  const row = db.insertBuildWorker({
    serverId: server.id,
    name: `${name}-${suffix}`,
    previousPool: "general",
  });
  db.updateBuildWorker(row.id, {
    status: "online",
    disk_free_bytes: HEALTHY_DISK_BYTES,
    last_checked_at: new Date().toISOString(),
  });
  return { row: db.getBuildWorker(row.id)!, server };
}

function observation(overrides: Partial<WorkerObservation> = {}): WorkerObservation {
  return {
    online: true,
    version: "test",
    architecture: "x86_64",
    diskFreeBytes: HEALTHY_DISK_BYTES,
    error: "",
    ...overrides,
  };
}

function transport(observations: Map<number, WorkerObservation>): BuildTransport {
  return {
    probeWorker: async (server: ServerRow) => observations.get(server.id) ?? observation(),
    buildCommit: async () => ({ refs: new Map(), files: {} }),
    verifyArtifact: async () => true,
  };
}

beforeEach(() => {
  connection.query("DELETE FROM build_worker_leases").run();
  connection.query("DELETE FROM operations").run();
  connection.query("DELETE FROM build_sources").run();
  connection.query("DELETE FROM build_workers").run();
  connection.query("DELETE FROM servers").run();
});

describe("build coordinator", () => {
  test("selects the preferred compatible worker ahead of a roomier worker", async () => {
    const preferred = worker("preferred");
    const roomier = worker("roomier");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map([
      [preferred.server.id, observation({ diskFreeBytes: 20 * 1024 ** 3 })],
      [roomier.server.id, observation({ diskFreeBytes: 80 * 1024 ** 3 })],
    ])));

    const result = await coordinator.withWorker({
      operationId: op.id,
      preferredWorkerId: preferred.row.id,
      run: async (selection) => selection.workerId,
    });

    expect(result).toEqual({ value: preferred.row.id, workerId: preferred.row.id });
  });

  test("fails over when the preferred worker is offline", async () => {
    const preferred = worker("offline-preferred");
    const fallback = worker("online-fallback");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map([
      [preferred.server.id, observation({ online: false, error: "unreachable" })],
      [fallback.server.id, observation()],
    ])));

    const result = await coordinator.withWorker({
      operationId: op.id,
      preferredWorkerId: preferred.row.id,
      run: async (selection) => selection.workerId,
    });

    expect(result.workerId).toBe(fallback.row.id);
    expect(db.getBuildWorker(preferred.row.id)?.status).toBe("offline");
  });

  test("holds a durable lease during the callback and releases it after success", async () => {
    const candidate = worker("success-lease");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));

    const result = await coordinator.withWorker({
      operationId: op.id,
      run: async (selection) => {
        const lease = db.getBuildWorkerLeaseForOperation(op.id);
        expect(lease?.worker_id).toBe(candidate.row.id);
        expect(db.getActiveBuildWorkerLease(candidate.row.id)?.operation_id).toBe(op.id);
        return "built";
      },
    });

    expect(result).toEqual({ value: "built", workerId: candidate.row.id });
    expect(db.getBuildWorkerLeaseForOperation(op.id)).toBeNull();
  });

  test("releases the durable lease when the callback fails", async () => {
    const candidate = worker("failure-lease");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));

    await expect(coordinator.withWorker({
      operationId: op.id,
      run: async () => {
        expect(db.getBuildWorkerLeaseForOperation(op.id)?.worker_id).toBe(candidate.row.id);
        throw new Error("build failed");
      },
    })).rejects.toThrow("build failed");

    expect(db.getBuildWorkerLeaseForOperation(op.id)).toBeNull();
  });

  test("falls back when the preferred worker slot is already leased", async () => {
    const preferred = worker("busy-preferred");
    const fallback = worker("idle-fallback");
    const occupyingOp = operation();
    const op = operation();
    const occupied = db.tryAcquireBuildWorkerLease({
      operationId: occupyingOp.id,
      candidateWorkerIds: [preferred.row.id],
    });
    expect(occupied?.worker_id).toBe(preferred.row.id);
    const coordinator = createBuildCoordinator(transport(new Map()));

    const result = await coordinator.withWorker({
      operationId: op.id,
      preferredWorkerId: preferred.row.id,
      run: async (selection) => selection.workerId,
    });

    expect(result.workerId).toBe(fallback.row.id);
    expect(db.getBuildWorkerLeaseForOperation(occupyingOp.id)?.lease_token).toBe(occupied?.lease_token);
  });

  test("waits for a busy worker and reports the wait before building", async () => {
    const candidate = worker("queued");
    const first = operation();
    const second = operation();
    markOperationRunning(second.id);
    insertStep({ opId: second.id, seq: 1, step: "build_and_push", phase: "forward", status: "executing" });
    const coordinator = createBuildCoordinator(transport(new Map()));
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstBuild = coordinator.withWorker({
      operationId: first.id,
      run: async () => { firstStarted(); await firstHeld; return "first"; },
    });
    await firstReady;

    let parked = 0;
    let unparked = 0;
    const queuedBuild = withBuildFailover({
      ctx: {
        opId: second.id,
        isCancelRequested: () => false,
        log: () => {},
        park: () => { parked++; },
        unpark: () => { unparked++; },
      },
      coordinator,
      capacityWaitMs: 1_000,
      capacityPollMs: 5,
      run: async ({ workerId }) => workerId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSteps(second.id)[0].detail).toStartWith("Waiting for build worker");
    expect(parked).toBe(1);
    releaseFirst();
    await firstBuild;
    expect((await queuedBuild).workerId).toBe(candidate.row.id);
    expect(unparked).toBe(1);
  });

  test("bounds the wait for worker capacity", async () => {
    const candidate = worker("timeout");
    const occupying = operation();
    const waiting = operation();
    const lease = db.tryAcquireBuildWorkerLease({ operationId: occupying.id, candidateWorkerIds: [candidate.row.id] });
    expect(lease).not.toBeNull();
    const coordinator = createBuildCoordinator(transport(new Map()));
    await expect(withBuildFailover({
      ctx: { opId: waiting.id, isCancelRequested: () => false, log: () => {} },
      coordinator,
      capacityWaitMs: 5,
      capacityPollMs: 5,
      run: async () => "never",
    })).rejects.toThrow("Timed out waiting");
    expect(db.getBuildWorkerLeaseForOperation(occupying.id)).not.toBeNull();
  });

  test.each([
    ["changed", (operationId: number) => {
      connection.query("UPDATE build_worker_leases SET lease_token = ? WHERE operation_id = ?")
        .run(crypto.randomUUID(), operationId);
    }],
    ["deleted", (operationId: number) => {
      connection.query("DELETE FROM build_worker_leases WHERE operation_id = ?").run(operationId);
    }],
  ] as const)("rejects a callback result when its lease token is %s", async (_case, fenceLease) => {
    worker(`fenced-${_case}`);
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));

    await expect(coordinator.withWorker({
      operationId: op.id,
      run: async () => {
        fenceLease(op.id);
        return "must-not-publish";
      },
    })).rejects.toThrow("Build worker lease was lost before publication could be committed");
  });

  test("retries one infrastructure failure on a different worker", async () => {
    const preferred = worker("failover-preferred");
    const fallback = worker("failover-fallback");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));
    const attempted: number[] = [];

    const result = await withBuildFailover({
      ctx: { opId: op.id, isCancelRequested: () => false, log: () => {} },
      coordinator,
      preferredWorkerId: preferred.row.id,
      run: async ({ workerId }) => {
        attempted.push(workerId);
        if (workerId === preferred.row.id) throw new BuildWorkerUnavailableError("disconnected");
        return "built";
      },
    });

    expect(result).toEqual({ value: "built", workerId: fallback.row.id });
    expect(attempted).toEqual([preferred.row.id, fallback.row.id]);
    expect(db.getBuildWorkerLeaseForOperation(op.id)).toBeNull();
  });

  test("does not retry after any digest was durably recorded", async () => {
    const preferred = worker("partial-preferred");
    worker("partial-fallback");
    const op = operation();
    const coordinator = createBuildCoordinator(transport(new Map()));
    let attempts = 0;

    await expect(withBuildFailover({
      ctx: { opId: op.id, isCancelRequested: () => false, log: () => {} },
      coordinator,
      preferredWorkerId: preferred.row.id,
      run: async ({ workerId }) => {
        attempts++;
        db.recordBuildArtifact({
          operationId: op.id,
          targetName: "api",
          imageRef: `registry.example.com/acme/api@sha256:${"a".repeat(64)}`,
          repository: "https://example.com/acme/repository.git",
          commitSha: "b".repeat(40),
          workerId,
        });
        throw new BuildWorkerUnavailableError("disconnected after publication");
      },
    })).rejects.toThrow("disconnected after publication");

    expect(attempts).toBe(1);
  });
});
