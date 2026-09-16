import template from "../../services/ntfy/.ocd-deploy.json";
import { ntfyDeployRequest } from "../engine/ntfy/app.ts";
import { test, expect } from "bun:test";
import * as db from "./db.ts";
import { NtfyBindingsSchema, NtfySettingsSchema } from "./ntfy-schema.ts";
import { ensureNtfyCredential, credentialSecret, prepareNtfyBindings, saveAppNtfy, appNtfyEnv, ntfyCredentials, retireAppNtfyCredentials, ntfyAccess } from "./ntfy.ts";
import { renderNtfyEnvironment, reconcileNtfyService } from "../engine/ntfy/service.ts";
import { enqueueNtfyIncident, deliverNtfy } from "../engine/ntfy/alerts.ts";

function enable() {
  const env = db.insertEnvironment("ntfy", '{"version":2,"entries":[]}');
  const app = db.insertApp({ name: "ntfy", domain: "notify.example.com", image_ref: `docker.io/binwiederhier/ntfy@sha256:${"a".repeat(64)}`, container_port: 80, environment_id: env.id, env_vars: JSON.stringify({ env: template.env, outputs: {} }) });
  db.default.query("UPDATE apps SET status='running', desired_replicas=1, volume_mount='/data:/var/lib/ntfy' WHERE id=?").run(app.id);
  db.saveSetting("ntfy_settings", JSON.stringify(NtfySettingsSchema.parse({ enabled: true, app_id: app.id, alerts: true, apps: true })));
  return db.getApp(app.id)!;
}
function user(id: string, admin = false) {
  db.insertUser({ id, username: id, password_hash: "unused", is_admin: admin });
  db.saveSetting(`ntfy_user.${id}`, JSON.stringify({ enabled: true, events: ["app", "delivery", "disk", "backup"], recovery: true }));
}
test("normal service manifest has private auth, persistent storage and bounded resources", async () => {
  const settings = NtfySettingsSchema.parse({ enabled: true, alerts: true, apps: true });
  const c = await ensureNtfyCredential("user", "alice");
  const config = renderNtfyEnvironment(settings, "notify.example.com", [{ ...c, token: (await credentialSecret(c)).token, access: "ro" }]);
  expect(config.NTFY_AUTH_ACCESS).toBe(`${c.username}:${c.topic}:ro`);
  expect(config.NTFY_UPSTREAM_BASE_URL).toBe("");
  expect(template.env.NTFY_AUTH_DEFAULT_ACCESS).toBe("deny-all");
  expect(template.env.NTFY_ENABLE_SIGNUP).toBe("false");
  const request = ntfyDeployRequest({ name: "ntfy", domain: "notify.example.com", server_id: 1 }, 2, `docker.io/binwiederhier/ntfy@sha256:${"a".repeat(64)}`);
  expect(request).toMatchObject({ volume_driver: "local-directory", volume_size: 1, volume_path: "/var/lib/ntfy", memory_mb: 128, cpu_limit: 0.5, environment_id: 2, replicas: 1, container_port: 80 });
});
test("integration uses encrypted normal app environment and reload operations, respects paused apps", async () => {
  const app = enable();
  await reconcileNtfyService();
  const environment = db.getEnvironment(app.environment_id!)!;
  const system = ntfyCredentials().find(c => c.owner_type === "system")!;
  expect(environment.env_vars).not.toContain((await credentialSecret(system)).token);
  const reload = db.default.query("SELECT id,kind FROM operations WHERE kind='reload_app'").all();
  expect(reload).toHaveLength(1);
  await reconcileNtfyService();
  expect(db.default.query("SELECT count(*) AS n FROM operations WHERE kind='reload_app'").get()).toEqual({ n: 1 });
  db.default.query("UPDATE operations SET status='done'").run();
  db.default.query("UPDATE apps SET status='paused' WHERE id=?").run(app.id);
  user("alice"); await ensureNtfyCredential("user", "alice");
  await reconcileNtfyService();
  expect(db.getApp(app.id)?.status).toBe("paused");
  expect(db.default.query("SELECT count(*) AS n FROM operations WHERE kind='reload_app'").get()).toEqual({ n: 1 });
});
test("attested app configuration does not trigger repeated reloads", async () => {
  const app = enable();
  await reconcileNtfyService();
  db.default.query("UPDATE operations SET status='done'").run();
  const server = db.insertServer({ name: "host", provider_id: "host", ipv4: "192.0.2.1", ipv6: "", type: "test", location: "test", status: "ready" });
  const replica = db.insertReplica({ app_id: app.id, server_id: server.id, host_port: 10000, container_name: "ntfy", status: "running" });
  db.default.query("UPDATE replicas SET config_revision=?,attested_at=datetime('now') WHERE id=?").run(db.getApp(app.id)!.config_revision, replica.id);
  await reconcileNtfyService();
  expect(db.default.query("SELECT count(*) AS n FROM operations WHERE kind='reload_app'").get()).toEqual({ n: 1 });
});
test("concurrent credential creation converges and stored credentials are encrypted", async () => {
  const [a, b] = await Promise.all([ensureNtfyCredential("user", "alice"), ensureNtfyCredential("user", "alice")]);
  expect(a).toEqual(b);
  const secret = await credentialSecret(a);
  expect(secret.token).toMatch(/^tk_[a-z0-9]{29}$/);
  expect(JSON.stringify(a)).not.toContain(secret.token);
  expect(await Bun.password.verify(secret.password, a.password_hash)).toBe(true);
});
test("app bindings isolate apps, access changes and generations; retirement follows attestation", async () => {
  enable();
  const binding = NtfyBindingsSchema.parse({ primary: { permissions: ["publish"] } });
  await prepareNtfyBindings(101, binding); saveAppNtfy(101, binding, true);
  await prepareNtfyBindings(102, binding); saveAppNtfy(102, binding, true);
  const a = await appNtfyEnv(101), b = await appNtfyEnv(102);
  expect(a.OCD_NTFY_TOKEN).not.toBe(b.OCD_NTFY_TOKEN);
  expect(a.OCD_NTFY_TOPIC).not.toBe(b.OCD_NTFY_TOPIC);
  const changed = NtfyBindingsSchema.parse({ primary: { permissions: ["subscribe"] } });
  await prepareNtfyBindings(101, changed);
  const next = await appNtfyEnv(101, changed);
  expect(next.OCD_NTFY_TOKEN).not.toBe(a.OCD_NTFY_TOKEN);
  expect(ntfyCredentials().filter(c => c.owner_id === "101")).toHaveLength(2);
  saveAppNtfy(101, changed, true); retireAppNtfyCredentials(101);
  expect(ntfyCredentials().filter(c => c.owner_id === "101")).toHaveLength(1);
  expect(ntfyAccess(changed.primary)).toBe("ro");
});
test("event fanout is permission-scoped and deduplicated", () => {
  enable(); user("admin", true); user("outsider");
  const incident = { key: "backup:failed", incident_id: "incident", title: "Backup failed", path: "/admin" };
  enqueueNtfyIncident(incident, false, 1000); enqueueNtfyIncident(incident, false, 1000);
  expect(db.default.query("SELECT user_id FROM ntfy_outbox").all()).toEqual([{ user_id: "admin" }]);
  expect(db.default.query("SELECT path FROM ntfy_outbox LIMIT 1").get()).toEqual({ path: "/incidents/incident" });
  enqueueNtfyIncident(incident, true, 2000);
  expect(db.default.query("SELECT count(*) AS n FROM ntfy_outbox").get()).toEqual({ n: 2 });
});
test("failed sends retry, redact provider errors, and recheck preference revocation", async () => {
  enable(); user("admin", true);
  await ensureNtfyCredential("system", "events"); await ensureNtfyCredential("user", "admin");
  enqueueNtfyIncident({ key: "backup:failed", incident_id: "incident", title: "Backup failed", path: "/admin" }, false, 1000);
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response("sensitive upstream diagnostic", { status: 503 }); }) as unknown as typeof fetch;
  await deliverNtfy(fetcher, 1000); await deliverNtfy(fetcher, 2000);
  expect(calls).toBe(1);
  expect(db.default.query("SELECT attempts,error FROM ntfy_outbox").get()).toEqual({ attempts: 1, error: "ntfy delivery failed; check service connectivity" });
  db.saveSetting("ntfy_user.admin", JSON.stringify({ enabled: false, events: ["backup"], recovery: true }));
  await deliverNtfy(fetcher, 32000);
  expect(calls).toBe(1);
  expect(db.default.query("SELECT count(*) AS n FROM ntfy_outbox").get()).toEqual({ n: 0 });
});

test("schema 116 upgrades ntfy tables without changing existing settings", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { initializeCurrentSchema } = await import("./db/current-schema.ts");
  const { createDatabase } = await import("./db/connection.ts");
  const folder = mkdtempSync(`${tmpdir()}/ocd-ntfy-migration-`);
  try {
    const path = `${folder}/db.sqlite`;
    const previous = new Database(path); initializeCurrentSchema(previous);
    previous.run("DROP TABLE ntfy_outbox"); previous.run("DROP TABLE ntfy_credentials"); previous.run("DROP TABLE incident_agent_runs");
    previous.run("UPDATE schema_version SET version=116");
    previous.run("INSERT INTO settings(key,value) VALUES ('preserve','value')"); previous.close();
    const upgraded = createDatabase(path);
    expect(upgraded.query("SELECT value FROM settings WHERE key='preserve'").get()).toEqual({ value: "value" });
    expect(upgraded.query("SELECT count(*) AS n FROM ntfy_credentials").get()).toEqual({ n: 0 });
    expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: 118 });
    expect(upgraded.query("SELECT count(*) AS n FROM incident_agent_runs").get()).toEqual({ n: 0 });
    upgraded.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
