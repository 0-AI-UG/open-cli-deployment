import * as db from "../../shared/db.ts";
import { ntfySettings, ntfyPreferences, ntfyCredentials, canReceiveNtfy, credentialSecret } from "../../shared/ntfy.ts";
export function enqueueNtfyIncident(incident: { key: string; incident_id: string; title: string; path: string }, recovered: boolean, now: number): void {
  const settings = ntfySettings();
  if (!settings?.enabled || !settings.alerts) return;
  for (const user of db.getUsers()) {
    if (!canReceiveNtfy(user.id, incident.key, recovered)) continue;
    const id = `${incident.incident_id}:${recovered ? "recovery" : "open"}:${user.id}`;
    db.default.query(`INSERT OR IGNORE INTO ntfy_outbox (id,user_id,incident_key,recovered,title,message,path,created_at,next_attempt) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, user.id, incident.key, Number(recovered), `[OCD] ${recovered ? "Recovered: " : ""}${incident.title}`, recovered ? "This condition has cleared." : "This condition needs attention. Open OCD to inspect details.", incident.path, now, now);
  }
}
export function enqueueNtfyTest(userId: string): string {
  const now = Date.now();
  const id = `test:${crypto.randomUUID()}`;
  db.default.query(`INSERT INTO ntfy_outbox (id,user_id,incident_key,recovered,title,message,path,created_at,next_attempt) VALUES (?,?,'test',0,'[OCD] Test notification','Your OCD notifications are configured.','/account',?,?)`).run(id, userId, now, now);
  return id;
}
type Delivery = { id: string; user_id: string; incident_key: string; recovered: number; title: string; message: string; path: string; attempts: number };
export async function deliverNtfy(fetcher: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const settings = ntfySettings();
  if (!settings?.enabled || !settings.alerts || db.getSettings().ntfy_status !== "ready") return;
  const credentials = ntfyCredentials();
  const publisher = credentials.find(c => c.owner_type === "system");
  if (!publisher) return;
  const token = (await credentialSecret(publisher)).token;
  const pending = db.default.query("SELECT * FROM ntfy_outbox WHERE sent_at IS NULL AND attempts<12 AND next_attempt<=? ORDER BY created_at LIMIT 10").all(now) as Delivery[];
  for (const item of pending) {
    const allowed = item.incident_key === "test"
      ? !!db.getUserById(item.user_id) && ntfyPreferences(item.user_id).enabled
      : canReceiveNtfy(item.user_id, item.incident_key, !!item.recovered);
    if (!allowed) { db.default.query("DELETE FROM ntfy_outbox WHERE id=?").run(item.id); continue; }
    const recipient = credentials.find(c => c.owner_type === "user" && c.owner_id === item.user_id);
    if (!recipient) continue;
    try {
      const panel = db.getPanel();
      const response = await fetcher(`https://${settings.domain}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ topic: recipient.topic, title: item.title, message: item.message,
          tags: [item.recovered ? "white_check_mark" : "warning"], priority: item.recovered ? 3 : 4,
          ...(panel ? { click: `https://${panel.domain}/#${item.path}` } : {}) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      db.default.query("UPDATE ntfy_outbox SET sent_at=?,error='' WHERE id=?").run(now, item.id);
    } catch {
      db.default.query("UPDATE ntfy_outbox SET attempts=attempts+1,next_attempt=?,error='ntfy delivery failed; check service connectivity' WHERE id=?")
        .run(now + Math.min(3600_000, 30_000 * 2 ** item.attempts), item.id);
    }
  }
  db.default.query("DELETE FROM ntfy_outbox WHERE created_at<?").run(now - 30 * 86400_000);
}
