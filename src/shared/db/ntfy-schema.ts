import type { Database } from "bun:sqlite";
export function initializeNtfySchema(db: Database): void {
  db.run(`CREATE TABLE ntfy_credentials (
    id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
    binding TEXT NOT NULL, permissions TEXT NOT NULL DEFAULT '', generation INTEGER NOT NULL DEFAULT 0,
    topic TEXT NOT NULL, username TEXT NOT NULL, password_hash TEXT NOT NULL,
    encrypted_value TEXT NOT NULL, iv TEXT NOT NULL,
    UNIQUE(owner_type, owner_id, binding, generation, permissions)
  )`);
  db.run(`CREATE TABLE ntfy_outbox (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    incident_key TEXT NOT NULL, recovered INTEGER NOT NULL,
    title TEXT NOT NULL, message TEXT NOT NULL, path TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL, sent_at INTEGER, error TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`CREATE INDEX ntfy_outbox_pending ON ntfy_outbox(sent_at, next_attempt)`);
}
