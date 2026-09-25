import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { initializeIncidentHistorySchema } from "./incident-history-schema.ts";

test("incident history initializes independently with one row per occurrence", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE panel_alerts (incident_id TEXT, key TEXT, title TEXT, path TEXT, first_seen INTEGER, opened_at INTEGER, resolved_at INTEGER)");
    db.run("CREATE TABLE ntfy_outbox (incident_key TEXT, title TEXT, path TEXT, created_at INTEGER, recovered INTEGER)");
    initializeIncidentHistorySchema(db);
    const insert = db.query("INSERT INTO panel_incident_history VALUES (?, 'app:7', 'App unhealthy', '/apps/7', ?, ?, ?)");
    insert.run("first", 1000, 1100, 2000);
    insert.run("second", 3000, 3100, null);
    expect(db.query("SELECT incident_id,resolved_at FROM panel_incident_history ORDER BY first_seen").all()).toEqual([
      { incident_id: "first", resolved_at: 2000 },
      { incident_id: "second", resolved_at: null },
    ]);
    expect(() => insert.run("first", 4000, 4100, null)).toThrow();
  } finally { db.close(); }
});

test("history migration keeps current incidents and older notification links", () => {
  const db = new Database(":memory:");
  try {
    db.run("CREATE TABLE panel_alerts (incident_id TEXT, key TEXT, title TEXT, path TEXT, first_seen INTEGER, opened_at INTEGER, resolved_at INTEGER)");
    db.run("CREATE TABLE ntfy_outbox (incident_key TEXT, title TEXT, path TEXT, created_at INTEGER, recovered INTEGER)");
    const old = "11111111-1111-4111-8111-111111111111";
    const current = "22222222-2222-4222-8222-222222222222";
    db.query("INSERT INTO panel_alerts VALUES (?,?,?,?,?,?,?)").run(current, "app:7", "App is unhealthy", "/apps/7", 3000, 3100, null);
    db.query("INSERT INTO ntfy_outbox VALUES (?,?,?,?,?)").run("app:7", "[OCD] App is unhealthy", `/incidents/${old}`, 1000, 0);
    db.query("INSERT INTO ntfy_outbox VALUES (?,?,?,?,?)").run("app:7", "[OCD] Recovered: App is unhealthy", `/incidents/${old}`, 2000, 1);
    initializeIncidentHistorySchema(db);
    expect(db.query("SELECT incident_id,resolved_at FROM panel_incident_history ORDER BY first_seen").all()).toEqual([
      { incident_id: old, resolved_at: 2000 },
      { incident_id: current, resolved_at: null },
    ]);
  } finally { db.close(); }
});
