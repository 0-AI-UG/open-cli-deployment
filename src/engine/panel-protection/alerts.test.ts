import { test, expect, beforeEach } from "bun:test";
import db, { saveSetting, insertUser, insertServer, insertServerMetricSample } from "../../shared/db.ts";
import { NtfySettingsSchema } from "../../shared/ntfy-schema.ts";
import { reconcileIncidents, alertTick, collectConditions } from "./alerts.ts";

beforeEach(() => {
  db.query("DELETE FROM ntfy_outbox").run();
  db.query("DELETE FROM panel_incident_history").run();
  db.query("DELETE FROM panel_alerts").run();
  db.query("DELETE FROM users WHERE id='recipient'").run();
  db.query("DELETE FROM panel_backups").run();
});

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
  const first = db.query("SELECT incident_id,opened_at,resolved_at FROM panel_incident_history WHERE key='app:1'").get() as { incident_id: string; opened_at: number; resolved_at: number | null };
  expect(first.opened_at).toBe(121000);
  expect(db.query("SELECT path FROM ntfy_outbox WHERE recovered=0 LIMIT 1").get()).toEqual({ path: `/incidents/${first.incident_id}` });
  reconcileIncidents([], 220000); reconcileIncidents([], 240000);
  expect(count()).toBe(2);
  expect(db.query("SELECT path FROM ntfy_outbox WHERE recovered=1 LIMIT 1").get()).toEqual({ path: `/incidents/${first.incident_id}` });
  expect((db.query("SELECT resolved_at FROM panel_incident_history WHERE incident_id=?").get(first.incident_id) as { resolved_at: number }).resolved_at).toBe(220000);
  reconcileIncidents(condition, 300000); reconcileIncidents(condition, 420000);
  expect(count()).toBe(3);
  expect((db.query("SELECT count(*) AS n FROM panel_incident_history WHERE key='app:1'").get() as { n: number }).n).toBe(2);
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
test("disk alert fires before a small rollout host reaches the pull limit", () => {
  const server = insertServer({
    name: "disk-alert-host", provider_id: "disk-alert-host", ipv4: "192.0.2.10",
    ipv6: "", type: "test", location: "test", status: "ready",
  });
  insertServerMetricSample(server.id, 0, 0, 15.5, 20);
  expect(collectConditions().some((condition) => condition.key === `disk:${server.id}`)).toBe(true);
});
