import { useTempDataDir, seedTestUser } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Bypass authentication, keeping the rest of the module real.
const realPermissions = await import("../lib/permissions.ts");
mock.module("../lib/permissions.ts", () => ({
  ...realPermissions,
  // seedTestUser() is idempotent and runs per request, not at module load:
  // other suites wipe the whole `users` table — file order is not ours.
  requireAuthenticated: async () => ({ userId: seedTestUser(), username: "test-user" }),
}));

const fakeHetzner = {
  validateToken: (tok: string) => {
    if (!tok || tok.length < 32) return { valid: false, error: "too short" };
    if (!/^[\x20-\x7e]+$/.test(tok)) return { valid: false, error: "bad chars" };
    return { valid: true, value: tok };
  },
  listServerTypes: async () => [
    { name: "cx22", description: "2 vCPU", cores: 2, memory: 4, disk: 40, locations: ["fsn1"] },
  ],
  verifyToken: async () => {},
  ensureSshKey: async () => ({ id: "k", name: "k" }),
  ensureFirewall: async () => "fw-1",
  ensureFirewallAttached: async () => {},
  createServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "running" }),
  getServer: async () => ({ providerId: "", ipv4: "", ipv6: "", status: "running" }),
  waitForRunning: async () => {},
  deleteServer: async () => {},
  listServers: async () => [],
};
mock.module("../../shared/hetzner/index.ts", () => ({ hetzner: fakeHetzner }));
const realS3 = await import("../../engine/object-storage/s3.ts");
mock.module("../../engine/object-storage/s3.ts", () => ({
  ...realS3,
  listBuckets: async () => [],
}));

import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import {
  handleGetSettings,
  handleSaveSettings,
} from "./settings.ts";

function req(body?: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  await secretStore.delete("hetzner_api_token");
  await secretStore.delete("hetzner_s3_access_key");
  await secretStore.delete("hetzner_s3_secret_key");
  await secretStore.delete("github_build_token");
  await secretStore.delete("oci_registry_password");
});

describe("GitHub build credentials", () => {
  test("persists, masks, and ignores a masked re-submission of the build token", async () => {
    await handleSaveSettings(req({ github_build_token: "ghp_buildtoken123456789" }));
    expect(await secretStore.get("github_build_token")).toBe("ghp_buildtoken123456789");
    const body = await (await handleGetSettings(req())).json() as Record<string, string>;
    expect(body.github_build_token).not.toContain("buildtoken123");
    await handleSaveSettings(req({ github_build_token: body.github_build_token }));
    expect(await secretStore.get("github_build_token")).toBe("ghp_buildtoken123456789");
  });
});

describe("handleSaveSettings: plain db settings", () => {
  test("stores an OCI repository allowlist and masks credentials", async () => {
    const r = await handleSaveSettings(req({
      oci_artifact_ref: "registry.example/ocd/artifacts",
      oci_registry_username: "deployer",
      oci_registry_password: "registry-secret-value",
    }));
    expect(r.status).toBe(200);
    expect(db.getSettings().oci_artifact_ref).toBe("registry.example/ocd/artifacts");
    expect(await secretStore.get("oci_registry_password")).toBe("registry-secret-value");
    const shown = await (await handleGetSettings(req())).json() as Record<string, unknown>;
    expect(shown.oci_registry_password).not.toBe("registry-secret-value");
  });

  test("rejects invalid OCI repository defaults", async () => {
    const r = await handleSaveSettings(req({ oci_artifact_ref: "not-a-repository" }));
    expect(r.status).toBe(400);
  });

  test("saves the default domain suffix", async () => {
    const r = await handleSaveSettings(req({ default_domain_suffix: "apps.example.org" }));
    expect(r.status).toBe(200);
    expect(db.getSettings().default_domain_suffix).toBe("apps.example.org");
  });

  test("rejects the removed automatic-provisioning server defaults", async () => {
    const r = await handleSaveSettings(req({ default_server_type: "cx22" }));
    expect(r.status).toBe(400);
  });

  test("rejects invalid default domain suffixes", async () => {
    const r = await handleSaveSettings(req({ default_domain_suffix: "https://bad.example/path" }));
    expect(r.status).toBe(400);
  });

  test("rejects removed provider and DNS settings instead of persisting them", async () => {
    for (const key of ["provider_token", "compute_provider", "dns_provider", "dns_zone_id", "dns_zone_name", "infrastructure_provisioner", "infrastructure_token", "object_storage_access_key"]) {
      const r = await handleSaveSettings(req({ [key]: "legacy-value" }));
      expect(r.status).toBe(400);
      expect(db.getSettings()[key]).toBeUndefined();
    }
  });

  test("require_2fa is coerced to '1' / '0' string", async () => {
    await handleSaveSettings(req({ require_2fa: true }));
    expect(db.getSettings().require_2fa).toBe("1");
    await handleSaveSettings(req({ require_2fa: false }));
    expect(db.getSettings().require_2fa).toBe("0");
  });

});

describe("Hetzner settings", () => {
  test("stores a verified API token and masks it", async () => {
    const token = "t".repeat(64);
    expect((await handleSaveSettings(req({ hetzner_api_token: token }))).status).toBe(200);
    expect(await secretStore.get("hetzner_api_token")).toBe(token);
    const body = await (await handleGetSettings(req())).json();
    expect(body.hetzner_configured).toBe(true);
    expect(body.hetzner_api_token).toBe("tttt...tttt");
    expect((await handleSaveSettings(req({ hetzner_api_token: body.hetzner_api_token }))).status).toBe(200);
    expect(await secretStore.get("hetzner_api_token")).toBe(token);
    await handleSaveSettings(req({ hetzner_api_token: "" }));
    expect(await secretStore.get("hetzner_api_token")).toBeNull();
  });

  test("rejects an invalid API token", async () => {
    expect((await handleSaveSettings(req({ hetzner_api_token: "short" }))).status).toBe(400);
    expect(await secretStore.get("hetzner_api_token")).toBeNull();
  });

  test("stores Object Storage credentials and region", async () => {
    const r = await handleSaveSettings(req({
      hetzner_s3_access_key: "access-key",
      hetzner_s3_secret_key: "secret-key-value",
      hetzner_s3_region: "nbg1",
    }));
    expect(r.status).toBe(200);
    const body = await (await handleGetSettings(req())).json();
    expect(body.hetzner_s3_configured).toBe(true);
    expect(body.hetzner_s3_region).toBe("nbg1");
    expect(body.hetzner_s3_regions).toEqual(["fsn1", "nbg1", "hel1"]);
  });

  test("rejects an unknown region or a single Object Storage key", async () => {
    expect((await handleSaveSettings(req({ hetzner_s3_region: "us-east-1" }))).status).toBe(400);
    expect((await handleSaveSettings(req({ hetzner_s3_access_key: "only-access" }))).status).toBe(400);
    expect(await secretStore.get("hetzner_s3_access_key")).toBeNull();
  });
});
