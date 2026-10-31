import type { Database } from "bun:sqlite";

export function initializeCiSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS ci_runners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL UNIQUE REFERENCES servers(id) ON DELETE RESTRICT,
    name TEXT NOT NULL UNIQUE,
    github_name TEXT NOT NULL UNIQUE,
    repository TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'repository' CHECK (scope IN ('repository','organization')),
    runner_group_id INTEGER,
    runner_group_name TEXT NOT NULL DEFAULT '',
    shared_builds INTEGER NOT NULL DEFAULT 0 CHECK (shared_builds IN (0,1)),
    host_reserved INTEGER NOT NULL DEFAULT 0 CHECK (host_reserved IN (0,1)),
    registered_at TEXT,
    job_timeout_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (job_timeout_seconds BETWEEN 60 AND 21600),
    status TEXT NOT NULL DEFAULT 'installing',
    draining INTEGER NOT NULL DEFAULT 0 CHECK (draining IN (0,1)),
    github_runner_id INTEGER,
    runner_version TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ci_check_policies (
    source_id INTEGER PRIMARY KEY REFERENCES build_sources(id) ON DELETE CASCADE,
    checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
    timeout_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (timeout_seconds BETWEEN 60 AND 86400)
  )`);
}
