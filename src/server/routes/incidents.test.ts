import { useTempDataDir, seedTestAdmin } from "../../shared/test-helpers.ts";
useTempDataDir();

import { expect, test } from "bun:test";
import db, { saveSetting, insertApp, insertUser } from "../../shared/db.ts";
import { alertTick, reconcileIncidents } from "../../engine/panel-protection/alerts.ts";
import { createToken } from "../lib/auth.ts";
import { handleListIncidents, handleGetIncident, handleResolveIncident } from "./incidents.ts";

test("incidents open and resolve without ntfy, remain in history", async () => {
  const userId = seedTestAdmin();
  saveSetting("panel_backup_enabled", "1");
  saveSetting("panel_backup_enabled_at", "1");
  await alertTick();
  const active = db.query("SELECT * FROM panel_incident_history WHERE key='backup:overdue'").get() as { incident_id: string; opened_at: number; resolved_at: number | null };
  expect(active.opened_at).toBeGreaterThan(0);
  expect(active.resolved_at).toBeNull();

  saveSetting("panel_backup_enabled", "0");
  await alertTick();
  const token = await createToken({ userId, username: "admin" });
  const headers = { authorization: `Bearer ${token}` };
  const list = await handleListIncidents(new Request("http://localhost/api/incidents?status=resolved", { headers }));
  expect(list.status).toBe(200);
  const body = await list.json() as { incidents: Array<{ incident_id: string; resolved_at: number | null }> };
  expect(body.incidents.some(item => item.incident_id === active.incident_id && item.resolved_at !== null)).toBe(true);

  const detail = await handleGetIncident(new Request(`http://localhost/api/incidents/${active.incident_id}`, { headers }));
  expect((await detail.json() as { incident: { resolved_at: number | null } }).incident.resolved_at).not.toBeNull();

});

test("app-scoped users see only their incidents", async () => {
  const app = insertApp({ name: "incident-test-app", domain: "incident-test.example.com", image_ref: `example/app@sha256:${"a".repeat(64)}`, container_port: 8080, env_vars: "{}" });
  insertUser({ id: "incident-viewer", username: "incident-viewer", password_hash: "unused", is_admin: false });
  db.query("INSERT INTO user_permissions(user_id,permission,scope_type,scope_id) VALUES (?,?,?,?)").run("incident-viewer", "apps.view", "app", String(app.id));
  reconcileIncidents([
    { key: `app:${app.id}`, title: "App unhealthy", path: `/apps/${app.id}` },
    { key: "backup:failed", title: "Panel backup failed", path: "/admin" },
  ], Date.now());
  const token = await createToken({ userId: "incident-viewer", username: "incident-viewer" });
  const headers = { authorization: `Bearer ${token}` };
  const response = await handleListIncidents(new Request("http://localhost/api/incidents", { headers }));
  expect(response.status).toBe(200);
  const body = await response.json() as { incidents: Array<{ key: string }> };
  expect(body.incidents.map(item => item.key)).toEqual([`app:${app.id}`]);
  const backup = db.query("SELECT incident_id FROM panel_incident_history WHERE key='backup:failed'").get() as { incident_id: string };
  const denied = await handleGetIncident(new Request(`http://localhost/api/incidents/${backup.incident_id}`, { headers }));
  expect(denied.status).toBe(403);
});

test("pagination and counts use only visible incidents and filters reject invalid input", async () => {
  const userId = seedTestAdmin();
  db.query("DELETE FROM panel_incident_history").run();
  const insert = db.query("INSERT INTO panel_incident_history VALUES (?, 'backup:failed', 'Backup failed', '/admin', ?, ?, ?)");
  for (let i = 0; i < 55; i++) insert.run(`page-${i}`, i, i, i < 3 ? i + 1 : null);
  const token = await createToken({ userId, username: "admin" });
  const headers = { authorization: `Bearer ${token}` };
  const list = async (query: string) => handleListIncidents(new Request(`http://localhost/api/incidents?${query}`, { headers }));
  const first = await (await list("status=active")).json();
  expect(first.incidents).toHaveLength(50);
  expect(first.counts).toEqual({ all: 55, active: 52, resolved: 3 });
  expect(first.nextOffset).toBe(50);
  const second = await (await list("status=active&offset=50")).json();
  expect(second.incidents).toHaveLength(2);
  expect(second.nextOffset).toBeNull();
  expect(new Set([...first.incidents, ...second.incidents].map(row => row.incident_id)).size).toBe(52);
  for (const query of ["status=invalid", "offset=-1", "offset=1.5", "offset=NaN"]) expect((await list(query)).status).toBe(400);
  const missing = await handleGetIncident(new Request("http://localhost/api/incidents/missing", { headers }));
  expect(missing.status).toBe(404);
});

test("manual resolution persists across monitoring, is idempotent, and allows later recurrences", async () => {
  const userId = seedTestAdmin();
  const headers = { authorization: `Bearer ${await createToken({ userId, username: "admin" })}` };
  const condition = { key: "backup:manual-test", title: "Backup failed", path: "/admin" };
  const now = Date.now();
  reconcileIncidents([condition], now);
  const original = db.query("SELECT * FROM panel_incident_history WHERE key=?").get(condition.key) as { incident_id: string };
  const request = () => new Request(`http://localhost/api/incidents/${original.incident_id}/resolve`, { method: "POST", headers });
  const response = await handleResolveIncident(request());
  expect(response.status).toBe(200);
  const { incident } = await response.json();
  expect(incident.resolved_at).toBeGreaterThanOrEqual(now);
  expect((await (await handleResolveIncident(request())).json()).incident.resolved_at).toBe(incident.resolved_at);
  reconcileIncidents([{ ...condition, title: "Later evidence" }], now + 1000);
  expect(db.query("SELECT incident_id,title,resolved_at FROM panel_incident_history WHERE key=?").all(condition.key)).toEqual([
    { incident_id: original.incident_id, title: condition.title, resolved_at: incident.resolved_at },
  ]);
  reconcileIncidents([], now + 2000);
  expect((await (await handleGetIncident(new Request(`http://localhost/api/incidents/${original.incident_id}`, { headers }))).json()).incident.resolved_at).toBe(incident.resolved_at);
  reconcileIncidents([condition], now + 3000);
  const occurrences = db.query("SELECT incident_id,resolved_at FROM panel_incident_history WHERE key=? ORDER BY first_seen").all(condition.key) as Array<{ incident_id: string; resolved_at: number | null }>;
  expect(occurrences).toHaveLength(2);
  expect(occurrences[1]!.incident_id).not.toBe(original.incident_id);
  expect(occurrences[1]!.resolved_at).toBeNull();
  expect((await handleResolveIncident(new Request("http://localhost/api/incidents/missing/resolve", { method: "POST", headers }))).status).toBe(404);
});

test("manual resolution requires app write access or admin access", async () => {
  const app = insertApp({ name: "manual-resolution", domain: "manual-resolution.example.com", image_ref: `example/app@sha256:${"a".repeat(64)}`, container_port: 8080, env_vars: "{}" });
  const userId = "incident-resolver";
  insertUser({ id: userId, username: userId, password_hash: "unused", is_admin: false });
  db.query("INSERT INTO user_permissions(user_id,permission,scope_type,scope_id) VALUES (?,?,?,?)").run(userId, "apps.view", "app", String(app.id));
  reconcileIncidents([{ key: `app:${app.id}`, title: "Unhealthy", path: `/apps/${app.id}` }, { key: "backup:restricted", title: "Backup failed", path: "/admin" }]);
  const headers = { authorization: `Bearer ${await createToken({ userId, username: userId })}` };
  const row = db.query("SELECT incident_id FROM panel_incident_history WHERE key=?").get(`app:${app.id}`) as { incident_id: string };
  const request = () => new Request(`http://localhost/api/incidents/${row.incident_id}/resolve`, { method: "POST", headers });
  const detail = () => handleGetIncident(new Request(`http://localhost/api/incidents/${row.incident_id}`, { headers }));
  expect((await (await detail()).json()).canResolve).toBe(false);
  expect((await handleResolveIncident(request())).status).toBe(403);
  db.query("INSERT INTO user_permissions(user_id,permission,scope_type,scope_id) VALUES (?,?,?,?)").run(userId, "apps.restart", "app", String(app.id + 1));
  expect((await handleResolveIncident(request())).status).toBe(403);
  db.query("INSERT INTO user_permissions(user_id,permission,scope_type,scope_id) VALUES (?,?,?,?)").run(userId, "apps.restart", "app", String(app.id));
  expect((await (await detail()).json()).canResolve).toBe(true);
  expect((await handleResolveIncident(request())).status).toBe(200);
  const backup = db.query("SELECT incident_id FROM panel_incident_history WHERE key='backup:restricted'").get() as { incident_id: string };
  expect((await handleResolveIncident(new Request(`http://localhost/api/incidents/${backup.incident_id}/resolve`, { method: "POST", headers }))).status).toBe(403);
});

test("incident endpoints require authentication", async () => {
  expect((await handleResolveIncident(new Request("http://localhost/api/incidents/missing/resolve", { method: "POST" }))).status).toBe(401);
  expect((await handleListIncidents(new Request("http://localhost/api/incidents"))).status).toBe(401);
  expect((await handleGetIncident(new Request("http://localhost/api/incidents/missing"))).status).toBe(401);
});
