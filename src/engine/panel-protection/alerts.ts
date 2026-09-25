import { enqueueNtfyIncident, deliverNtfy } from "../ntfy/alerts.ts";
import db, { getSettings, saveSetting } from "../../shared/db.ts";

export type Condition = { key: string; title: string; path: string; grace?: number; hold?: boolean };
type Incident = { key: string; incident_id: string; title: string; path: string; first_seen: number; opened_at: number | null; resolved_at: number | null };
export function reconcileIncidents(conditions: Condition[], now = Date.now()): void {
  db.transaction(() => {
    const active = new Set(conditions.map(c => c.key));
    for (const condition of conditions) {
      if (condition.hold) continue;
      let row = db.query("SELECT * FROM panel_alerts WHERE key=?").get(condition.key) as Incident | null;
      if (!row || row.resolved_at !== null) {
        db.query("INSERT OR REPLACE INTO panel_alerts (key, incident_id, title, path, first_seen) VALUES (?, ?, ?, ?, ?)").run(condition.key, crypto.randomUUID(), condition.title, condition.path, now);
        row = db.query("SELECT * FROM panel_alerts WHERE key=?").get(condition.key) as Incident;
      }
      // Repeated failures stay one incident, but link to the latest evidence.
      if (row.title !== condition.title || row.path !== condition.path) {
        db.query("UPDATE panel_alerts SET title=?,path=? WHERE key=?").run(condition.title, condition.path, row.key);
        db.query("UPDATE panel_incident_history SET title=?,path=? WHERE incident_id=?").run(condition.title, condition.path, row.incident_id);
        row.title = condition.title;
        row.path = condition.path;
      }
      if (row.opened_at === null && now - row.first_seen >= (condition.grace ?? 0)) {
        db.query("INSERT INTO panel_incident_history (incident_id,key,title,path,first_seen,opened_at) VALUES (?,?,?,?,?,?)")
          .run(row.incident_id, row.key, row.title, row.path, row.first_seen, now);
        enqueueNtfyIncident(row, false, now);
        db.query("UPDATE panel_alerts SET opened_at=? WHERE key=?").run(now, row.key);
      }
    }
    for (const row of db.query("SELECT * FROM panel_alerts WHERE resolved_at IS NULL").all() as Incident[]) {
      if (active.has(row.key)) continue;
      if (row.opened_at !== null) enqueueNtfyIncident(row, true, now);
      db.query("UPDATE panel_alerts SET resolved_at=? WHERE key=?").run(now, row.key);
      db.query("UPDATE panel_incident_history SET resolved_at=? WHERE incident_id=?").run(now, row.incident_id);
    }
  })();
}

export function collectConditions(now = Date.now()): Condition[] {
  const result: Condition[] = [];
  for (const app of db.query(`SELECT id, name FROM apps WHERE status='unhealthy'`).all() as { id: number; name: string }[]) {
    result.push({ key: `app:${app.id}`, title: `${app.name} is unhealthy`, path: `/apps/${app.id}`, grace: 120_000 });
  }
  for (const metric of db.query(`SELECT s.id, s.name, m.disk_used_gb, m.disk_total_gb FROM servers s JOIN server_metrics_samples m ON m.id=(SELECT id FROM server_metrics_samples WHERE server_id=s.id ORDER BY sampled_at DESC, id DESC LIMIT 1) WHERE m.sampled_at > datetime('now','-5 minutes') AND m.disk_total_gb > 0 AND (m.disk_used_gb/m.disk_total_gb >= 0.85 OR m.disk_total_gb-m.disk_used_gb < 5)`).all() as { id: number; name: string }[]) {
    result.push({ key: `disk:${metric.id}`, title: `${metric.name} has low disk headroom`, path: `/resources/servers/${metric.id}`, grace: 120_000 });
  }
  // A missing/stale scrape is not evidence that disk pressure recovered.
  for (const old of db.query(`SELECT a.key, a.title, a.path FROM panel_alerts a
      JOIN servers s ON a.key='disk:' || s.id
      WHERE a.resolved_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM server_metrics_samples m WHERE m.server_id=s.id
        AND m.sampled_at > datetime('now','-5 minutes') AND m.disk_total_gb > 0
      )`).all() as Condition[]) result.push({ ...old, hold: true });
  const settings = getSettings();
  {
    const latest = db.query("SELECT status FROM panel_backups WHERE status IN ('complete','failed') ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { status: string } | null;
    if (latest?.status === "failed") result.push({ key: "backup:failed", title: "Panel backup failed", path: "/admin" });
    const last = Number(settings.panel_backup_last_success || settings.panel_backup_enabled_at || now);
    if (settings.panel_backup_enabled === "1" && now - last > 26 * 3600_000) result.push({ key: "backup:overdue", title: "Panel backup is overdue", path: "/admin" });
  }
  // One incident per deployment target, resolved by a later successful delivery.
  const since = settings.incident_tracking_enabled_at || String(now);
  const operations = db.query(`SELECT id, kind, status, resource_keys FROM operations WHERE parent_id IS NULL AND kind IN ('deploy','deploy_stack','redeploy','build_app_delivery','build_stack_delivery','webhook_build_source','apply_manifest','promote','promote_stack','rollback') AND finished_at IS NOT NULL AND julianday(finished_at) >= julianday(?, 'unixepoch') ORDER BY id`).all(Number(since) / 1000) as { id: number; kind: string; status: string; resource_keys: string }[];
  const latest = new Map<string, typeof operations[number]>();
  for (const op of operations) if (op.status !== "cancelled") latest.set(op.resource_keys, op);
  for (const [target, op] of latest) {
    if (["failed", "compensated", "compensation_failed"].includes(op.status)) result.push({ key: `delivery:${target}`, title: `Deployment operation #${op.id} failed`, path: `/engine/op/${op.id}` });
  }
  return result;
}

export async function alertTick(): Promise<void> {
  const s = getSettings();
  if (!s.incident_tracking_enabled_at) saveSetting("incident_tracking_enabled_at", String(Date.now()));
  reconcileIncidents(collectConditions());
  await deliverNtfy();
}
