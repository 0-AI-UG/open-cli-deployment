import { test, expect, mock, beforeEach } from "bun:test";
import db, { saveSetting } from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
const realPermissions = await import("../lib/permissions.ts");
let allowed = true;
mock.module("../lib/permissions.ts", () => ({ ...realPermissions, requireAdmin: async () => { if (!allowed) { const e = new Error("Admin required"); Object.defineProperty(e, "constructor", { value: { name: "ForbiddenError" } }); throw e; } return { userId: "admin" }; } }));
const { handleSaveProtection, handleGetProtection, handleRecoveryKey } = await import("./panel-protection.ts");
const request = (body?: unknown) => new Request("https://panel.example/api/admin/protection", { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const config = { backup_connection: "", backup_enabled: false, backup_bucket: "", backup_prefix: "ocd-panel", backup_retention: 7 };
beforeEach(() => { allowed = true; });
test("protection settings configure backups without an email channel", async () => {
  expect((await handleSaveProtection(request(config))).status).toBe(200);
  const body = await (await handleGetProtection(request())).json();
  expect(body.backup_retention).toBe(7);
  for (const key of ["alert_enabled", "alert_recipient", "alert_sender", "resend_configured", "deliveries"]) expect(body).not.toHaveProperty(key);
  expect((await handleSaveProtection(request({ ...config, resend_key: "re_obsolete" }))).status).toBe(400);
  expect((await handleSaveProtection(request({ ...config, alert_enabled: true }))).status).toBe(400);
});
test("validation is atomic and requires prerequisites", async () => {
  expect((await handleSaveProtection(request({ ...config, backup_retention: 0 }))).status).toBe(400);
  expect(await secretStore.get("panel_alert_resend_key")).toBeNull();
  expect((await handleSaveProtection(request({ ...config, backup_enabled: true }))).status).toBe(400);
  expect((await handleSaveProtection(request({ ...config, unexpected: "x" }))).status).toBe(400);
});
test("key retrieval is admin only and stable", async () => {
  allowed = false;
  expect((await handleGetProtection(request())).status).toBe(403);
  expect((await handleRecoveryKey(request())).status).toBe(403);
  allowed = true;
  const first = await (await handleRecoveryKey(request())).json();
  const again = await (await handleRecoveryKey(request())).json();
  expect(first.recovery_key).toMatch(/^[a-f0-9]{64}$/);
  expect(again).toEqual(first);
});

test("simultaneous recovery-key requests return the same persisted key", async () => {
  const responses = await Promise.all([handleRecoveryKey(request()), handleRecoveryKey(request())]);
  const [a,b] = await Promise.all(responses.map(r => r.json()));
  expect(a).toEqual(b);
  expect(await secretStore.get("panel_backup_recovery_key")).toBe(a.recovery_key);
});
test("saving backup settings preserves notification incidents", async () => {
  db.query("INSERT INTO panel_alerts(key,incident_id,title,path,first_seen) VALUES ('app:1','incident','Unhealthy','/apps/1',1)").run();
  expect((await handleSaveProtection(request(config))).status).toBe(200);
  expect(db.query("SELECT incident_id FROM panel_alerts WHERE key='app:1'").get()).toEqual({ incident_id: "incident" });
});
