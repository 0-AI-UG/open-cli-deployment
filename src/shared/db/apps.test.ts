import { useTempDataDir, randomSuffix } from "../test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../db.ts";
import {
  INTERNAL_PORT_BASE,
  INTERNAL_PORT_COUNT,
  vipFromIndex,
} from "./apps.ts";

const IMAGE_REF = `ghcr.io/acme/test@sha256:${"a".repeat(64)}`;

function makeApp(name = `app-${randomSuffix()}`) {
  return db.insertApp({
    name,
    domain: `${name}.example.com`,
    image_ref: IMAGE_REF,
    container_port: 3000,
    env_vars: '{"env":{},"outputs":{}}',
  });
}

describe("immutable image contract", () => {
  test("rejects mutable tags on insert and artifact updates", () => {
    expect(() => db.insertApp({
      name: `mutable-${randomSuffix()}`,
      domain: "",
      image_ref: "ghcr.io/acme/test:latest",
      container_port: 3000,
      env_vars: '{"env":{},"outputs":{}}',
    })).toThrow(/immutable OCI reference/);

    const app = makeApp();
    expect(() => db.updateAppImageRef(app.id, "ghcr.io/acme/test:latest"))
      .toThrow(/immutable OCI reference/);
    expect(db.getApp(app.id)?.image_ref).toBe(IMAGE_REF);
    db.deleteApp(app.id);
  });
});

// The db module (and its temp data dir) is shared across all test files in
// the bun test process, so assertions are relative to the current state
// rather than assuming an empty apps table.
function lowestFreePort(): number {
  const used = new Set(db.getApps().map((a) => a.internal_port));
  for (let p = INTERNAL_PORT_BASE; ; p++) if (!used.has(p)) return p;
}

describe("internal port allocation", () => {
  test("insertApp allocates the lowest free port in the block", () => {
    const expected = lowestFreePort();
    const a = makeApp();
    expect(a.internal_port).toBe(expected);
    expect(a.internal_port).toBeGreaterThanOrEqual(INTERNAL_PORT_BASE);
    expect(a.internal_port).toBeLessThan(INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT);
  });

  test("allocation fills the lowest gap left by a deleted app", () => {
    const a = makeApp();
    const b = makeApp();
    expect(b.internal_port).toBeGreaterThan(a.internal_port);
    db.deleteApp(a.id);
    const c = makeApp();
    expect(c.internal_port).toBe(a.internal_port);
  });

  test("insertAppWithFirstReplica allocates a port; replica delete/re-add keeps it", () => {
    const server = db.insertServer({
      name: `srv-${randomSuffix()}`,
      provider_id: `h-${randomSuffix()}`,
      ipv4: "1.2.3.4",
      ipv6: "",
      type: "cx22",
      location: "fsn1",
      status: "ready",
    });
    const name = `app-${randomSuffix()}`;
    const { app, replica } = db.insertAppWithFirstReplica(
      {
        name,
        domain: `${name}.example.com`,
        image_ref: IMAGE_REF,
        container_port: 3000,
        env_vars: '{"env":{},"outputs":{}}',
      },
      server.id,
    );
    expect(app.internal_port).toBeGreaterThanOrEqual(INTERNAL_PORT_BASE);

    db.deleteReplica(replica.id);
    db.insertReplica({
      app_id: app.id,
      server_id: server.id,
      host_port: replica.host_port,
      container_name: name,
    });
    // The port lives on the app row — replica churn never reallocates it.
    expect(db.getApp(app.id)!.internal_port).toBe(app.internal_port);
    const next = makeApp();
    expect(next.internal_port).not.toBe(app.internal_port);
  });

  test("countApps tracks inserts and deletes", () => {
    const before = db.countApps();
    const a = makeApp();
    expect(db.countApps()).toBe(before + 1);
    db.deleteApp(a.id);
    expect(db.countApps()).toBe(before);
  });

  test("throws a clear error when all 200 ports are taken", () => {
    const fillers: number[] = [];
    try {
      while (db.countApps() < INTERNAL_PORT_COUNT) fillers.push(makeApp().id);
      expect(db.countApps()).toBe(INTERNAL_PORT_COUNT);
      expect(() => makeApp()).toThrow(/Fleet limit of 200 apps/);
    } finally {
      // Free the block again — later test files share this db.
      for (const id of fillers) db.deleteApp(id);
    }
  });
});

describe("environment staleness", () => {
  test("marks only apps whose env map consumes a changed key", () => {
    const env = db.insertEnvironment(`env-${randomSuffix()}`, "");
    const all = db.insertApp({
      name: `all-${randomSuffix()}`,
      domain: "",
      image_ref: IMAGE_REF,
      container_port: 3000,
      env_vars: '{"env":{"A":{"from":"environment.A"}},"outputs":{}}',
      environment_id: env.id,
    });
    const consumesA = db.insertApp({
      name: `a-${randomSuffix()}`,
      domain: "",
      image_ref: IMAGE_REF,
      container_port: 3000,
      env_vars: '{"env":{"A":{"from":"environment.A"}},"outputs":{}}',
      environment_id: env.id,

    });
    const onlyB = db.insertApp({
      name: `b-${randomSuffix()}`,
      domain: "",
      image_ref: IMAGE_REF,
      container_port: 3000,
      env_vars: '{"env":{"B":{"from":"environment.B"}},"outputs":{}}',
      environment_id: env.id,

    });

    expect(db.markAppsEnvironmentStaleForKeys(env.id, ["A"])).toBe(2);
    expect(db.getApp(all.id)?.environment_stale).toBe(1);
    expect(db.getApp(consumesA.id)?.environment_stale).toBe(1);
    expect(db.getApp(onlyB.id)?.environment_stale).toBe(0);

    db.markAppEnvironmentFresh(consumesA.id);
    expect(db.getApp(consumesA.id)?.environment_stale).toBe(0);
  });
});

describe("virtual IP allocation", () => {
  function lowestFreeVip(): string {
    const used = new Set(db.getApps().map((a) => a.virtual_ip));
    for (let i = 1; ; i++) if (!used.has(vipFromIndex(i))) return vipFromIndex(i);
  }

  test("insertApp allocates the lowest free VIP, starting at 10.96.0.1", () => {
    expect(vipFromIndex(1)).toBe("10.96.0.1");
    const expected = lowestFreeVip();
    const a = makeApp();
    expect(a.virtual_ip).toBe(expected);
    expect(a.virtual_ip).toMatch(/^10\.96\.\d+\.\d+$/);
    db.deleteApp(a.id);
  });

  test("allocation fills the lowest gap left by a deleted app", () => {
    const a = makeApp();
    const b = makeApp();
    expect(b.virtual_ip).not.toBe(a.virtual_ip);
    db.deleteApp(a.id);
    const c = makeApp();
    expect(c.virtual_ip).toBe(a.virtual_ip);
    db.deleteApp(b.id);
    db.deleteApp(c.id);
  });

  test("vipFromIndex rolls over the third octet at index 256", () => {
    expect(vipFromIndex(255)).toBe("10.96.0.255");
    expect(vipFromIndex(256)).toBe("10.96.1.0");
    expect(vipFromIndex(257)).toBe("10.96.1.1");
    expect(vipFromIndex(65534)).toBe("10.96.255.254");
  });

  test("vipFromIndex throws on out-of-range indexes", () => {
    expect(() => vipFromIndex(0)).toThrow(/out of range/);
    expect(() => vipFromIndex(65535)).toThrow(/out of range/);
    expect(() => vipFromIndex(-1)).toThrow(/out of range/);
    expect(() => vipFromIndex(1.5)).toThrow(/out of range/);
  });
});
