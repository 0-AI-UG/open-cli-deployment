import type { Database } from "bun:sqlite";

/** One durable row per outage occurrence. panel_alerts remains the reconciler's
 * current-condition table and can replace a row when the same condition recurs. */
export function initializeIncidentHistorySchema(db: Database): void {
  db.run(`CREATE TABLE panel_incident_history (
    incident_id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    opened_at INTEGER,
    resolved_at INTEGER
  )`);
  db.run("CREATE INDEX panel_incident_history_recent ON panel_incident_history(first_seen DESC)");
  db.run(`INSERT INTO panel_incident_history (incident_id,key,title,path,first_seen,opened_at,resolved_at)
    SELECT incident_id,key,title,path,first_seen,opened_at,resolved_at FROM panel_alerts WHERE opened_at IS NOT NULL`);

  // Recover older occurrences that notification delivery still knows about.
  const delivered = db.query("SELECT incident_key,title,path,created_at,recovered FROM ntfy_outbox WHERE path LIKE '/incidents/%' ORDER BY created_at").all() as
    Array<{ incident_key: string; title: string; path: string; created_at: number; recovered: number }>;
  const insert = db.prepare("INSERT OR IGNORE INTO panel_incident_history (incident_id,key,title,path,first_seen,opened_at,resolved_at) VALUES (?,?,?,?,?,?,?)");
  const resolve = db.prepare("UPDATE panel_incident_history SET resolved_at=COALESCE(resolved_at,?) WHERE incident_id=?");
  for (const event of delivered) {
    const id = event.path.slice("/incidents/".length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const key = event.incident_key;
    const opId = event.title.match(/operation #(\d+)/)?.[1];
    const resourcePath = key.startsWith("app:") ? `/apps/${Number(key.slice(4))}`
      : key.startsWith("disk:") ? `/resources/servers/${Number(key.slice(5))}`
      : opId ? `/engine/op/${opId}` : "/admin";
    insert.run(id, key, event.title.replace(/^\[OCD\] (?:Recovered: )?/, ""), resourcePath, event.created_at, event.created_at, event.recovered ? event.created_at : null);
    if (event.recovered) resolve.run(event.created_at, id);
  }
}
