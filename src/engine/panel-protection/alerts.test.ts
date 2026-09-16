import { test, expect } from "bun:test";
import db, { saveSetting, insertUser } from "../../shared/db.ts";
import { NtfySettingsSchema } from "../../shared/ntfy-schema.ts";
import { reconcileIncidents, alertTick, collectConditions } from "./alerts.ts";

function enable() {
  saveSetting("ntfy_settings", JSON.stringify(NtfySettingsSchema.parse({ enabled: true, alerts: true, apps: true })));
  insertUser({ id: "recipient", username: "recipient", password_hash: "unused", is_admin: true });
  saveSetting("ntfy_user.recipient", JSON.stringify({ enabled: true, events: ["app", "backup", "disk", "delivery"], recovery: true }));
}
const count = () => (db.query("SELECT count(*) AS n FROM ntfy_outbox").get() as { n: number }).n;
test("grace period, deduplication and recovery survive repeated evaluations", () => {
  enable();
  const condition = [{ key: "app:1", title: "App unhealthy", path: "/apps/1", grace: 120000 }];
  reconcileIncidents(condition, 1000); reconcileIncidents(condition, 120000);
  expect(count()).toBe(0);
  reconcileIncidents(condition, 121000); reconcileIncidents(condition, 200000);
  expect(count()).toBe(1);
  reconcileIncidents([], 220000); reconcileIncidents([], 240000);
  expect(count()).toBe(2);
  reconcileIncidents(condition, 300000); reconcileIncidents(condition, 420000);
  expect(count()).toBe(3);
});
test("transient conditions do not send recovery notifications", () => {
  enable(); reconcileIncidents([{ key: "app:1", title: "Unhealthy", path: "/apps/1", grace: 120000 }], 1000);
  reconcileIncidents([], 3000); expect(count()).toBe(0);
});
test("legacy email settings cannot enable alert evaluation", async () => {
  saveSetting("panel_alert_enabled", "1");
  saveSetting("panel_alert_recipient", "former@example.com");
  await alertTick();
  expect(db.query("SELECT count(*) AS n FROM panel_alerts").get()).toEqual({ n: 0 });
  expect(count()).toBe(0);
});
test("overdue panel backups use last successful backup or initial enable time", () => {
  saveSetting("panel_backup_enabled", "1"); saveSetting("panel_backup_enabled_at", "1000");
  expect(collectConditions(1000 + 27 * 3600000).some(c => c.key === "backup:overdue")).toBe(true);
  saveSetting("panel_backup_last_success", String(1000 + 26 * 3600000));
  expect(collectConditions(1000 + 27 * 3600000).some(c => c.key === "backup:overdue")).toBe(false);
});
test("retrying a failed backup does not send recovery until a verified backup succeeds", () => {
  db.query("INSERT INTO panel_backups (id,created_at,status,bucket,object_key,endpoint,connection_id,region) VALUES ('failed',1,'failed','b','k','e','test','test'), ('retry',2,'running','b','k2','e','test','test')").run();
  expect(collectConditions().some(c => c.key === "backup:failed")).toBe(true);
  db.query("UPDATE panel_backups SET status='complete' WHERE id='retry'").run();
  expect(collectConditions().some(c => c.key === "backup:failed")).toBe(false);
});
test("unknown observations retain incidents without falsely resolving them", () => {
  enable();
  reconcileIncidents([{ key: "disk:1", title: "Disk full", path: "/resources/servers/1" }], 1000);
  reconcileIncidents([{ key: "disk:1", title: "Disk full", path: "/resources/servers/1", hold: true }], 2000);
  expect(count()).toBe(1);
});
