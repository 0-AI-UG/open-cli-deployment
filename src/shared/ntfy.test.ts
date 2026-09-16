import { test, expect } from "bun:test";
import * as db from "./db.ts";
import { NtfyBindingsSchema, NtfySettingsSchema } from "./ntfy-schema.ts";
import { ensureNtfyCredential, credentialSecret, prepareNtfyBindings, saveAppNtfy, appNtfyEnv, ntfyCredentials, retireAppNtfyCredentials, ntfyAccess } from "./ntfy.ts";
import { renderNtfyConfig, buildNtfyInstallScript, renderNtfyIngress } from "../engine/ntfy/service.ts";
import { enqueueNtfyIncident, deliverNtfy } from "../engine/ntfy/alerts.ts";

function enable() {
  db.saveSetting("ntfy_settings", JSON.stringify(NtfySettingsSchema.parse({ enabled: true, domain: "notify.example.com", alerts: true, apps: true })));
  db.saveSetting("ntfy_status", "ready");
}
function user(id: string, admin = false) {
  db.insertUser({ id, username: id, password_hash: "unused", is_admin: admin });
  db.saveSetting(`ntfy_user.${id}`, JSON.stringify({ enabled: true, events: ["app", "delivery", "disk", "backup"], recovery: true }));
}
test("private server configuration and bounded resources", async () => {
  const settings = NtfySettingsSchema.parse({ enabled: true, domain: "notify.example.com", alerts: true, apps: true });
  const c = await ensureNtfyCredential("user", "alice");
  const config = JSON.parse(renderNtfyConfig(settings, [{ ...c, token: (await credentialSecret(c)).token, access: "ro" }]));
  expect(config["auth-default-access"]).toBe("deny-all");
  expect(config["auth-access"]).toEqual([`${c.username}:${c.topic}:ro`]);
  expect(config["enable-signup"]).toBe(false);
  expect(config["attachment-cache-dir"]).toBeUndefined();
  expect(config["upstream-base-url"]).toBeUndefined();
  const script = buildNtfyInstallScript(`docker.io/binwiederhier/ntfy@sha256:${"a".repeat(64)}`, JSON.stringify(config), renderNtfyIngress(settings.domain), true);
  expect(script).toContain("--memory 128m --memory-swap 128m --cpus 0.5");
  expect(script).toContain("127.0.0.1:8894:80");
  expect(script).toContain("umask 077");
  expect(() => buildNtfyInstallScript("ntfy:latest", "", "", true)).toThrow();
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
    previous.run("DROP TABLE ntfy_outbox"); previous.run("DROP TABLE ntfy_credentials");
    previous.run("UPDATE schema_version SET version=116");
    previous.run("INSERT INTO settings(key,value) VALUES ('preserve','value')"); previous.close();
    const upgraded = createDatabase(path);
    expect(upgraded.query("SELECT value FROM settings WHERE key='preserve'").get()).toEqual({ value: "value" });
    expect(upgraded.query("SELECT count(*) AS n FROM ntfy_credentials").get()).toEqual({ n: 0 });
    expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: 117 });
    upgraded.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
