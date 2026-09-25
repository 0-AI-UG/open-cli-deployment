import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeCurrentSchema, CURRENT_SCHEMA_VERSION } from "../../shared/db/current-schema.ts";
import { assertMigrationCatalogCurrent, createDatabase } from "../../shared/db/connection.ts";
import { runMigrations, migrations } from "../../shared/migrations.ts";

test("current schema version matches the latest migration", () => {
  expect(migrations.at(-1)?.version).toBe(CURRENT_SCHEMA_VERSION);
});

test("a stale schema declaration is rejected by the startup preflight", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-schema-guard-"));
  const filename = path.join(dir, "deploy.db");
  try {
    expect(() => assertMigrationCatalogCurrent(CURRENT_SCHEMA_VERSION + 1)).toThrow("Migration catalog ends");
    const opened = createDatabase(filename);
    opened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("old layouts require an explicit offline cutover; current schema opens without changing settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-protection-schema-"));
  const filename = path.join(dir, "deploy.db");
  try {
    const old = new Database(filename);
    initializeCurrentSchema(old);
    old.run("INSERT INTO settings (key,value) VALUES ('existing','preserved')"); old.close();
    const upgraded = createDatabase(filename);
    expect(upgraded.query("SELECT version FROM schema_version").get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(upgraded.query("SELECT value FROM settings WHERE key='existing'").get()).toEqual({ value: "preserved" });
    expect(upgraded.query("SELECT count(*) AS n FROM panel_backups").get()).toEqual({ n: 0 });
    upgraded.run("UPDATE schema_version SET version=114"); upgraded.close();
    expect(() => createDatabase(filename)).toThrow("offline cutover");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upgrading removes retired incident agent records and its stored credential", () => {
  const db = new Database(":memory:");
  try {
    initializeCurrentSchema(db);
    db.run("UPDATE schema_version SET version=119");
    db.run("CREATE TABLE incident_agent_runs (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL)");
    db.run("INSERT INTO incident_agent_runs VALUES ('run-1', 'incident-1')");
    db.run("INSERT INTO encrypted_secrets (key, encrypted_value, iv) VALUES ('deepseek_api_key', 'old-ciphertext', 'old-iv'), ('other', 'keep', 'iv')");
    runMigrations(db);
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    expect(db.query("SELECT name FROM sqlite_master WHERE name='incident_agent_runs'").get()).toBeNull();
    expect(db.query("SELECT key FROM encrypted_secrets").all()).toEqual([{ key: "other" }]);
  } finally { db.close(); }
});
