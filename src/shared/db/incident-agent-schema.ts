import type { Database } from "bun:sqlite";

export function initializeIncidentAgentSchema(db: Database): void {
  db.run(`CREATE TABLE incident_agent_runs (
    id TEXT PRIMARY KEY,
    incident_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('investigate', 'fix')),
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
    result_json TEXT NOT NULL DEFAULT '{}',
    messages_json TEXT NOT NULL DEFAULT '[]',
    activity_json TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX incident_agent_runs_incident ON incident_agent_runs(incident_id, user_id, created_at DESC)");
}
