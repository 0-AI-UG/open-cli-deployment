import { useTempDataDir, randomSuffix } from "./test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "./db.ts";
import {
  applyAppConfig,
  classifyAppConfigChanges,
  classifyConfigOnlyChanges,
  diffAppConfig,
  mergeDeployRequestWithExistingApp,
} from "./app-config.ts";
import { serializeEnvVars } from "./env-crypto.ts";

const IMAGE_REF = `ghcr.io/acme/app@sha256:${"a".repeat(64)}`;
// The preload wipes every table before each test, so servers are seeded per test.
let SERVER: db.ServerRow;
let SECOND_SERVER: db.ServerRow;
function seedServers() {
  SERVER = db.insertServer({
    name: `placed-${randomSuffix()}`, provider_id: "", ipv4: "198.51.100.5", ipv6: "",
    type: "cx23", location: "nbg1", status: "ready",
  });
  SECOND_SERVER = db.insertServer({
    name: `placed-b-${randomSuffix()}`, provider_id: "", ipv4: "198.51.100.6", ipv6: "",
    type: "cx23", location: "nbg1", status: "ready",
  });
}
/** Every request places the app on SERVER by name; storage resolves it to the id. */
const placement = () => ({ [SERVER.name]: 1 });

test("manifest reconciliation retains or explicitly selects the storage driver", () => {
  const app = { name: "storage-app", container_port: 5432, desired_volume_driver: "hetzner-block" } as db.AppRow;
  expect(mergeDeployRequestWithExistingApp(app, { volume_size: 10 }).volume_driver).toBe("hetzner-block");
  expect(mergeDeployRequestWithExistingApp(app, { volume_size: 10, volume_driver: "local-directory" }).volume_driver).toBe("local-directory");
});

describe("classifyAppConfigChanges", () => {
  test("separates control, runtime, and artifact changes", () => {
    expect(classifyAppConfigChanges([{ field: "sticky", before: false, after: true }])).toBe("control");
    expect(classifyAppConfigChanges([{ field: "container_port", before: 3000, after: 4000 }])).toBe("runtime");
    expect(classifyAppConfigChanges([{ field: "image_ref", before: "old", after: "new" }])).toBe("artifact");
    expect(classifyAppConfigChanges([
      { field: "container_port", before: 3000, after: 4000 },
      { field: "image_ref", before: "", after: "registry/app@sha256:abc" },
    ])).toBe("artifact");
  });

  test("config-only recreates runtime state while deferring artifact rollout", () => {
    const runtime = { field: "memory_mb", before: 512, after: 1024 };
    const artifact = { field: "image_ref", before: "old", after: "new" };
    expect(classifyConfigOnlyChanges([runtime])).toEqual({ rollout: "runtime", pendingRollout: false });
    expect(classifyConfigOnlyChanges([artifact])).toEqual({ rollout: "control", pendingRollout: true });
    expect(classifyConfigOnlyChanges([runtime, artifact])).toEqual({ rollout: "runtime", pendingRollout: true });
    expect(classifyConfigOnlyChanges([], { environmentChanged: true }))
      .toEqual({ rollout: "runtime", pendingRollout: false });
  });
});

function seedApp() {
  seedServers();
  const suffix = randomSuffix();
  const env = db.insertEnvironment(`env-${suffix}`, serializeEnvVars([]));
  const app = db.insertApp({
    name: `app-${suffix}`,
    domain: `${suffix}.example.com`,
    image_ref: IMAGE_REF,
    container_port: 3000,
    env_vars: "{}",
    environment_id: env.id,
    placement: { [String(SERVER.id)]: 1 },
  });
  return { app, env };
}

describe("desired app configuration", () => {
  test("diffs and applies a complete manifest spec without deploying code", async () => {
    const { app, env } = seedApp();
    const req = {
      app_name: app.name,
      image_ref: `ghcr.io/acme/app@sha256:${"b".repeat(64)}`,
      container_port: 8080,
      environment_id: env.id,
      env_projection: ["API_KEY"],
      env_vars: [{ key: "API_KEY", value: "secret", secret: true }],
      public: false,
      memory_mb: 1024,
      cpu_limit: 1.5,
      health_check: false,
      internal_protocol: "tcp" as const,
      placement: { [SERVER.name]: 1, [String(SECOND_SERVER.id)]: 2 },
      manifest_path: ".ocd-deploy.json",
      manifest_hash: "abc123",
      apply_mode: "manifest" as const,
      command: ["postgres"],
      cap_add: ["CHOWN", "SETUID"],
      post_start_command: "pg_isready",
    };

    expect(diffAppConfig(app, req).map((c) => c.field)).toContain("image_ref");
    await applyAppConfig(app.id, req);

    const updated = db.getApp(app.id)!;
    expect(updated.image_ref).toBe(req.image_ref);
    expect(updated.container_port).toBe(8080);
    expect(updated.public).toBe(0);
    expect(updated.memory_mb).toBe(1024);
    expect(updated.cpu_limit).toBe(1.5);
    expect(updated.internal_protocol).toBe("tcp");
    expect(JSON.parse(updated.placement!)).toEqual({ [String(SERVER.id)]: 1, [String(SECOND_SERVER.id)]: 2 });
    expect(db.parseAppCommand(updated)).toEqual(["postgres"]);
    expect(db.parseAppCapabilities(updated)).toEqual(["CHOWN", "SETUID"]);
    expect(updated.post_start_command).toBe("pg_isready");
    expect(updated.manifest_path).toBe(".ocd-deploy.json");
    expect(updated.last_manifest_path).toBe(".ocd-deploy.json");
    expect(updated.last_manifest_hash).toBe("abc123");
    expect(updated.last_manifest_config_revision).toBe(updated.config_revision);
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("an explicit identical candidate rollout commits the revision used by its replicas", async () => {
    const { app } = seedApp();
    const request = { app_name: app.name, placement: placement(), image_ref: app.image_ref, container_port: 3000, env: {} };
    await applyAppConfig(app.id, request);
    const before = db.getApp(app.id)!;
    expect(diffAppConfig(before, request)).toEqual([]);
    await applyAppConfig(app.id, request, { forceRevision: true });
    expect(db.getApp(app.id)!.config_revision).toBe(before.config_revision + 1);
    await applyAppConfig(app.id, request);
    expect(db.getApp(app.id)!.config_revision).toBe(before.config_revision + 1);
  });

  test("runtime config remains app-local and literal values are redacted from diffs", async () => {
    const {app,env} = seedApp();
    const request = {app_name:app.name, placement: placement(),image_ref:app.image_ref,container_port:3000,environment_id:env.id,env:{TOKEN:"private-literal"}};
    const beforeEnvironment = db.getEnvironment(env.id)!.env_vars;
    const beforeRevision = app.config_revision;
    const changes = await applyAppConfig(app.id, request);
    expect(JSON.stringify(changes)).not.toContain("private-literal");
    expect(JSON.parse(db.getApp(app.id)!.env_vars).env.TOKEN).toBe("private-literal");
    expect(db.getApp(app.id)!.config_revision).toBeGreaterThan(beforeRevision);
    expect(db.getEnvironment(env.id)!.env_vars).toBe(beforeEnvironment);
  });

  test("reordering runtime map keys neither changes configuration nor requests a rollout", async () => {
    const { app } = seedApp();
    const request = { app_name: app.name, placement: placement(), image_ref: app.image_ref, container_port: 3000,
      env: { B: "two", A: "one" }, outputs: { URL: { template: "http://{app.host}" }, PORT: { template: "{app.port}" } } };
    await applyAppConfig(app.id, request);
    const before = db.getApp(app.id)!;
    const reordered = { ...request, env: { A: "one", B: "two" }, outputs: { PORT: request.outputs.PORT, URL: request.outputs.URL } };
    expect(diffAppConfig(before, reordered)).toEqual([]);
    await applyAppConfig(app.id, reordered);
    expect(db.getApp(app.id)!.config_revision).toBe(before.config_revision);
  });

  test("missing runtime references fail before desired config or environment linkage changes", async () => {
    const {app,env} = seedApp();
    const before = db.getApp(app.id)!;
    await expect(applyAppConfig(app.id, {app_name:app.name, placement: placement(),image_ref:app.image_ref,container_port:4000,env:{TOKEN:{from:"environment.MISSING"}}})).rejects.toThrow("none is selected");
    expect(db.getApp(app.id)).toEqual(before);
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("omitting environment_id detaches without deleting the environment", async () => {
    const { app, env } = seedApp();
    await applyAppConfig(app.id, {
      app_name: app.name, placement: placement(),
      image_ref: app.image_ref,
      container_port: 3000,
    });
    expect(db.getApp(app.id)?.environment_id).toBeNull();
    expect(db.getEnvironment(env.id)).not.toBeNull();
  });

  test("manifest mode resets omitted fields and supports explicit detach", async () => {
    const { app } = seedApp();
    db.updateAppPlacement(app.id, { [String(SECOND_SERVER.id)]: 3 });
    db.updateAppExtraVolumes(app.id, ["/srv/data:/data"]);
    await applyAppConfig(app.id, {
      apply_mode: "manifest",
      app_name: app.name, placement: placement(),
      image_ref: app.image_ref,
      container_port: 3000,
      environment_id: null,
      health_check: false,
    });
    const updated = db.getApp(app.id)!;
    expect(updated.environment_id).toBeNull();
    expect(updated.health_check).toBe(0);
    expect(updated.health_check_mode).toBe("container");
    expect(JSON.parse(updated.placement!)).toEqual({ [String(SERVER.id)]: 1 });
    expect(db.parseExtraVolumes(updated.extra_volumes)).toEqual([]);
  });

  test("records primary-volume intent without mutating observed attachment state", async () => {
    const { app } = seedApp();
    db.updateAppVolume(app.id, "vol-old", "/mnt/vol-old:/old", true);
    db.updateAppDesiredVolume(app.id, { volumeId: "vol-old", sizeGb: 20, mountPath: "/old" });

    const req = {
      apply_mode: "manifest" as const,
      app_name: app.name, placement: placement(),
      image_ref: app.image_ref,
      container_port: 3000,
      volume_id: "vol-new",
      volume_size: 40,
      volume_path: "/data",
    };
    expect(diffAppConfig(db.getApp(app.id)!, req).map((change) => change.field)).toEqual(
      expect.arrayContaining(["desired_volume_id", "desired_volume_size", "desired_volume_path"]),
    );

    await applyAppConfig(app.id, req);
    const updated = db.getApp(app.id)!;
    expect(updated.desired_volume_id).toBe("vol-new");
    expect(updated.desired_volume_size).toBe(40);
    expect(updated.desired_volume_path).toBe("/data");
    expect(updated.volume_id).toBe("vol-old");
    expect(updated.volume_mount).toBe("/mnt/vol-old:/old");
  });

  test("only a release-authorized apply can preserve an unchanged legacy volume sentinel", async () => {
    const { app } = seedApp();
    db.updateAppDesiredVolume(app.id, {
      volumeId: "legacy-volume-42",
      sizeGb: -1,
      mountPath: "/data",
    });
    const req = {
      app_name: app.name, placement: placement(),
      image_ref: `ghcr.io/acme/app@sha256:${"c".repeat(64)}`,
      container_port: 3000,
      volume_id: "legacy-volume-42",
      volume_size: -1,
      volume_path: "/data",
    };

    await expect(applyAppConfig(app.id, req)).rejects.toThrow("Volume size must be 0 or a positive integer");
    await applyAppConfig(app.id, req, { allowUnchangedLegacyVolumeIntent: true });
    const updated = db.getApp(app.id)!;
    expect(updated.image_ref).toBe(req.image_ref);
    expect(updated.desired_volume_id).toBe("legacy-volume-42");
    expect(updated.desired_volume_size).toBe(-1);
    expect(updated.desired_volume_path).toBe("/data");
  });

  test("editing a linked environment advances the desired-config revision", () => {
    const { app, env } = seedApp();
    db.updateAppEnvVars(app.id, JSON.stringify({env:{API_URL:{from:"environment.API_URL"}},outputs:{}}));
    const before = db.getApp(app.id)!.config_revision;

    db.updateEnvironment(
      env.id,
      env.name,
      serializeEnvVars([{
        key: "API_URL",
        value: "https://example.com",
        secret: false,
        updated_at: new Date().toISOString(),
      }]),
    );

    expect(db.getApp(app.id)!.config_revision).toBe(before + 1);
  });
});

describe("placement changes", () => {
  const volumeRequest = (app: db.AppRow, target: string) => ({
    apply_mode: "manifest" as const,
    app_name: app.name,
    image_ref: app.image_ref,
    container_port: 3000,
    volume_size: 10,
    volume_path: "/data",
    placement: { [target]: 1 },
  });

  test("a volume app cannot change servers through a deploy", async () => {
    const { app } = seedApp();
    db.updateAppVolume(app.id, "vol-1", "/mnt/vol-1:/data", true);
    db.updateAppDesiredVolume(app.id, { volumeId: "", sizeGb: 10, mountPath: "/data" });
    const current = db.getApp(app.id)!;
    expect(() => diffAppConfig(current, volumeRequest(current, SERVER.name))).not.toThrow();
    expect(() => diffAppConfig(current, volumeRequest(current, SECOND_SERVER.name)))
      .toThrow(`ocd move ${app.name} --to ${SECOND_SERVER.name}`);
    await expect(applyAppConfig(app.id, volumeRequest(current, SECOND_SERVER.name))).rejects.toThrow("ocd move");
    expect(JSON.parse(db.getApp(app.id)!.placement!)).toEqual({ [String(SERVER.id)]: 1 });
  });

  test("a stateless app may change placement to any ready app server", async () => {
    const { app } = seedApp();
    await applyAppConfig(app.id, {
      app_name: app.name, image_ref: app.image_ref, container_port: 3000,
      placement: { [SERVER.name]: 1, [SECOND_SERVER.name]: 2 },
    });
    expect(JSON.parse(db.getApp(app.id)!.placement!)).toEqual({ [String(SERVER.id)]: 1, [String(SECOND_SERVER.id)]: 2 });
  });

  test("a new placement server must be ready and not a build worker", async () => {
    const { app } = seedApp();
    const request = (target: string) => ({
      app_name: app.name, image_ref: app.image_ref, container_port: 3000, placement: { [target]: 1 },
    });
    db.updateServerStatus(SECOND_SERVER.id, "provisioning");
    await expect(applyAppConfig(app.id, request(SECOND_SERVER.name))).rejects.toThrow("not ready");
    db.updateServerStatus(SECOND_SERVER.id, "ready");
    db.insertBuildWorker({ serverId: SECOND_SERVER.id, name: `builder-${randomSuffix()}` });
    await expect(applyAppConfig(app.id, request(SECOND_SERVER.name))).rejects.toThrow("build worker");
    await expect(applyAppConfig(app.id, request("missing-server"))).rejects.toThrow("does not exist");
    expect(JSON.parse(db.getApp(app.id)!.placement!)).toEqual({ [String(SERVER.id)]: 1 });
  });
});
