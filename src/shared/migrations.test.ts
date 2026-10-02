import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, migrations, type Migration } from "./migrations.ts";

const IMAGE_REF = `ghcr.io/acme/test@sha256:${"a".repeat(64)}`;

/** Historical-fixture tests seed v0 source rows. Give those rows their manual
 * cutover artifact immediately before the clean-cut migration runs. */
function runMigrationsWithImageCutover(db: Database, upTo = Infinity): void {
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL DEFAULT 0)");
  if (!db.query("SELECT version FROM schema_version").get()) {
    db.run("INSERT INTO schema_version (version) VALUES (0)");
  }
  for (const migration of migrations) {
    if (migration.version > upTo) break;
    if (migration.version === 105) {
      db.run("UPDATE apps SET image_ref = ?", [IMAGE_REF]);
    }
    if (migration.disableForeignKeys) db.run("PRAGMA foreign_keys = OFF");
    migration.up(db);
    db.run("UPDATE schema_version SET version = ?", [migration.version]);
    if (migration.disableForeignKeys) db.run("PRAGMA foreign_keys = ON");
  }
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  // Create baseline schema (version 0)
  db.run(`CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hetzner_id TEXT NOT NULL UNIQUE,
    ipv4 TEXT NOT NULL DEFAULT '',
    ipv6 TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'cx23',
    location TEXT NOT NULL DEFAULT 'nbg1',
    status TEXT NOT NULL DEFAULT 'provisioning',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    git_repo TEXT NOT NULL,
    dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
    container_port INTEGER NOT NULL DEFAULT 3000,
    env_vars TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'deploying',
    deploy_log TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);
  return db;
}

describe("runMigrations", () => {
  test("creates schema_version table", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    const row = db.query("SELECT version FROM schema_version").get() as any;
    expect(row).toBeTruthy();
    expect(row.version).toBeGreaterThanOrEqual(0);
  });

  test("applies all migrations", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    const row = db.query("SELECT version FROM schema_version").get() as any;
    expect(row.version).toBeGreaterThan(0);
  });

  test("migration 112 removes empty managed-service tables and retired grants", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 112);

    for (const table of ["services", "service_instances", "service_links"]) {
      expect(db.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)).toBeNull();
    }
    expect(db.query(
      "SELECT 1 FROM user_permissions WHERE permission LIKE 'services.%'",
    ).get()).toBeNull();
  });

  test("migration 112 refuses to remove a nonempty managed-service schema", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE services (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    db.run("CREATE TABLE service_instances (id INTEGER PRIMARY KEY, service_id INTEGER)");
    db.run("CREATE TABLE service_links (id INTEGER PRIMARY KEY, service_id INTEGER)");
    db.run("CREATE TABLE user_permissions (permission TEXT NOT NULL)");
    db.run("INSERT INTO services (name) VALUES ('database')");
    db.run("INSERT INTO user_permissions (permission) VALUES ('services.view')");

    expect(() => migrations.find((migration) => migration.version === 112)!.up(db))
      .toThrow("Migrate them to apps first");
    expect(db.query("SELECT name FROM services").get()).toEqual({ name: "database" });
    expect(db.query("SELECT permission FROM user_permissions").get())
      .toEqual({ permission: "services.view" });
  });

  test("migration 122 drops provider-era server and backup columns", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ["provider", "ownership", "management_address", "ssh_user", "ssh_port"]) {
      expect(columns("servers")).not.toContain(column);
    }
    expect(columns("panel_backups")).not.toContain("connection_id");
  });

  test("migration 123 removes scale-to-zero and autoscaling state", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 122);
    db.run("INSERT INTO servers (id, name, provider_id, status) VALUES (1, 'srv', 'h-1', 'ready')");
    db.run(`INSERT INTO apps (id, name, domain, image_ref, status, desired_replicas, autoscale_enabled, sleeping_server_id)
      VALUES (1, 'asleep', '', ?, 'sleeping', 0, 1, 1), (2, 'awake', '', ?, 'running', 2, 0, NULL)`, [IMAGE_REF, IMAGE_REF]);
    db.run(`INSERT INTO replicas (app_id, server_id, host_port, container_name, status)
      VALUES (1, 1, 10001, 'asleep-r1', 'stopped'), (2, 1, 10002, 'awake-r1', 'running')`);
    db.run(`INSERT INTO scaling_events (app_id, event_type, from_count, to_count, reason)
      VALUES (1, 'autoscale_sleep', 1, 0, 'autoscaler'), (2, 'auto_restart', 1, 1, 'health')`);
    db.run("INSERT INTO settings (key, value) VALUES ('proxy_wake_secret', 'x')");

    migrations.find((m) => m.version === 123)!.up(db);

    const columns = (db.query("PRAGMA table_info(apps)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of [
      "autoscale_enabled", "autoscale_cpu_threshold", "autoscale_mem_threshold", "autoscale_cooldown",
      "autoscale_req_threshold", "last_scale_at", "min_replicas", "max_replicas", "scale_to_zero_after",
      "sleeping_server_id", "sleeping_host_port", "last_request_at", "requests_per_min",
    ]) {
      expect(columns).not.toContain(column);
    }
    expect(db.query("SELECT status, desired_replicas FROM apps ORDER BY id").all()).toEqual([
      { status: "unhealthy", desired_replicas: 1 },
      { status: "running", desired_replicas: 2 },
    ]);
    expect(db.query("SELECT status FROM replicas WHERE app_id = 1").get()).toEqual({ status: "unhealthy" });
    expect(db.query("SELECT event_type FROM scaling_events").all()).toEqual([{ event_type: "auto_restart" }]);
    expect(db.query("SELECT value FROM settings WHERE key = 'proxy_wake_secret'").get()).toBeNull();

    // The recreated trigger still bumps the revision on declared-config edits.
    const before = (db.query("SELECT config_revision FROM apps WHERE id = 2").get() as { config_revision: number }).config_revision;
    db.run("UPDATE apps SET desired_replicas = 3 WHERE id = 2");
    expect(db.query("SELECT config_revision FROM apps WHERE id = 2").get()).toEqual({ config_revision: before + 1 });
  });

  test("migration 124 backfills explicit placement from live replicas and drops automatic placement", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 123);
    db.run(`INSERT INTO servers (id, name, provider_id, status, pool) VALUES
      (1, 'panel', 'h-1', 'ready', 'general'), (5, 'server-5', 'h-5', 'ready', 'general'),
      (13, 'builder', 'h-13', 'ready', 'build-workers'), (15, 'server-15', 'h-15', 'ready', 'general')`);
    db.run("INSERT INTO build_workers (server_id, name, previous_pool, status) VALUES (13, 'builder', 'general', 'online')");
    db.run(`INSERT INTO apps (id, name, domain, image_ref, status, desired_replicas, durability_class, max_per_host, min_locations, placement_pool)
      VALUES (1, 'sight-scan', '', ?, 'running', 2, 'standard', 1, 1, 'general'),
             (2, 'blog', '', ?, 'running', 1, 'none', 0, 1, 'general'),
             (3, 'fresh', '', ?, 'deploying', 1, 'none', 0, 1, 'general')`, [IMAGE_REF, IMAGE_REF, IMAGE_REF]);
    db.run(`INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES
      (1, 5, 10001, 'sight-scan', 'running'), (1, 15, 10001, 'sight-scan-r2', 'unhealthy'),
      (2, 1, 10002, 'blog', 'running'), (2, 1, 10003, 'blog-r2', 'starting')`);
    db.run(`INSERT INTO availability_samples (app_id, meets_target, desired_count, running_count, distinct_hosts, distinct_locations)
      VALUES (1, 1, 2, 2, 2, 1)`);
    db.run("INSERT INTO settings (key, value) VALUES ('default_server_type', 'cx23'), ('default_location', 'nbg1')");

    migrations.find((m) => m.version === 124)!.up(db);

    expect(db.query("SELECT id, placement FROM apps ORDER BY id").all()).toEqual([
      { id: 1, placement: JSON.stringify({ "5": 1, "15": 1 }) },
      { id: 2, placement: JSON.stringify({ "1": 2 }) },
      { id: 3, placement: null },
    ]);
    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ["desired_replicas", "durability_class", "max_per_host", "min_locations", "placement_pool"]) {
      expect(columns("apps")).not.toContain(column);
    }
    expect(columns("servers")).not.toContain("pool");
    expect(columns("build_workers")).not.toContain("previous_pool");
    expect(columns("availability_samples")).not.toContain("distinct_hosts");
    expect(db.query("SELECT server_id FROM build_workers").get()).toEqual({ server_id: 13 });
    expect(db.query("SELECT count(*) AS n FROM settings WHERE key IN ('default_server_type', 'default_location')").get()).toEqual({ n: 0 });

    // A placement change is a declared-config change and bumps the revision.
    const before = (db.query("SELECT config_revision FROM apps WHERE id = 1").get() as { config_revision: number }).config_revision;
    db.run(`UPDATE apps SET placement = '{"5":2}' WHERE id = 1`);
    expect(db.query("SELECT config_revision FROM apps WHERE id = 1").get()).toEqual({ config_revision: before + 1 });
  });

  test("migration 126 drops GitHub identity, post-start, rollback, and scoped grants", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 125);
    db.run("INSERT INTO users (id, username, password_hash, github_id, github_username) VALUES ('u1', 'ops', 'x', 42, 'octo')");
    db.run(`INSERT INTO user_permissions (user_id, permission, scope_type, scope_id) VALUES
      ('u1', 'apps.deploy', 'global', NULL), ('u1', 'apps.rollback', 'global', NULL), ('u1', 'apps.view', 'app', '7')`);
    db.run("INSERT INTO settings (key, value) VALUES ('github_oauth_client_id', 'cid')");

    migrations.find((m) => m.version === 126)!.up(db);

    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ["github_id", "github_username", "github_avatar_url", "github_linked_at"]) {
      expect(columns("users")).not.toContain(column);
    }
    expect(columns("apps")).not.toContain("post_start_command");
    expect(db.query("SELECT username FROM users").get()).toEqual({ username: "ops" });
    expect(db.query("SELECT permission FROM user_permissions").all()).toEqual([{ permission: "apps.deploy" }]);
    expect(db.query("SELECT 1 FROM settings WHERE key = 'github_oauth_client_id'").get()).toBeNull();
  });

  test("migration 127 drops user permissions and the admin role", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 126);
    db.run("INSERT INTO users (id, username, password_hash, is_admin) VALUES ('u1', 'ops', 'x', 1), ('u2', 'dev', 'y', 0)");
    db.run("INSERT INTO user_permissions (user_id, permission) VALUES ('u2', 'apps.deploy')");
    db.run(`INSERT INTO panel_incident_history (incident_id, key, title, path, first_seen, opened_at)
      VALUES ('i1', 'backup:failed', 'Backup failed', '/admin', 1, 1), ('i2', 'app:1', 'Down', '/apps/1', 1, 1)`);
    db.run("INSERT INTO panel_deployments (image_tag, source) VALUES ('a', 'admin-main-release'), ('b', 'manual')");

    migrations.find((m) => m.version === 127)!.up(db);

    const columns = (db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain("is_admin");
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'user_permissions'").get()).toBeNull();
    expect(db.query("SELECT id, username FROM users ORDER BY id").all())
      .toEqual([{ id: "u1", username: "ops" }, { id: "u2", username: "dev" }]);
    expect(db.query("SELECT path FROM panel_incident_history ORDER BY incident_id").all())
      .toEqual([{ path: "/settings?section=panel" }, { path: "/apps/1" }]);
    expect(db.query("SELECT source FROM panel_deployments ORDER BY image_tag").all())
      .toEqual([{ source: "main-release" }, { source: "manual" }]);
  });

  test("migration 125 drops removed-feature columns and keeps everything else", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 124);
    db.run(`INSERT INTO servers (id, name, provider_id, status, ipv4, gc_requested_at)
      VALUES (1, 'srv', 'h-1', 'ready', '203.0.113.5', '2026-09-01 00:00:00')`);
    db.run(`INSERT INTO apps (id, name, domain, image_ref, status, auth_password_hash, sticky, ip_allowlist,
        public_port, public_protocol, extra_volumes, target, target_of, health_check_mode, rate_limit_rps,
        compress, internal_protocol, placement, virtual_ip)
      VALUES (1, 'db', 'db.example.com', ?, 'running', '$2b$hash', 1, '10.0.0.0/8', 30001, 'udp',
        '["/srv/a:/a"]', 'staging', NULL, 'periodic_job', 50, 1, 'tcp', '{"1":1}', '10.96.0.1'),
        (2, 'web', '', ?, 'running', '', 0, '', NULL, 'tcp', '[]', '', 1, 'http', 0, 0, 'http', '{"1":2}', '10.96.0.2')`,
      [IMAGE_REF, IMAGE_REF]);
    db.run(`INSERT INTO replicas (id, app_id, server_id, host_port, container_name, status, stopped_at)
      VALUES (1, 1, 1, 10001, 'db', 'running', '2026-09-01 00:00:00')`);
    db.run(`INSERT INTO stacks (id, name, status, staging_environment_id, staging_env_keys)
      VALUES (1, 'bc', 'running', 7, '["A"]')`);
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'ops', 'x')");
    db.run(`INSERT INTO user_permissions (user_id, permission) VALUES
      ('u1', 'apps.promote'), ('u1', 'stacks.promote'), ('u1', 'apps.deploy')`);

    migrations.find((m) => m.version === 125)!.up(db);

    const columns = (table: string) => (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of [
      "auth_password_hash", "sticky", "ip_allowlist", "public_port", "public_protocol", "extra_volumes",
      "target", "target_of", "compose_file", "compose_web_service", "deploy_mode", "userns", "env_projection",
    ]) {
      expect(columns("apps")).not.toContain(column);
    }
    expect(columns("replicas")).not.toContain("stopped_at");
    expect(columns("servers")).not.toContain("gc_requested_at");
    expect(columns("stacks")).not.toContain("staging_environment_id");
    expect(columns("stacks")).not.toContain("staging_env_keys");
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_apps_public_port'").get()).toBeNull();

    expect(db.query(`SELECT id, name, domain, status, health_check_mode, rate_limit_rps, compress,
        internal_protocol, placement, virtual_ip FROM apps ORDER BY id`).all()).toEqual([
      { id: 1, name: "db", domain: "db.example.com", status: "running", health_check_mode: "heartbeat", rate_limit_rps: 50,
        compress: 1, internal_protocol: "tcp", placement: '{"1":1}', virtual_ip: "10.96.0.1" },
      { id: 2, name: "web", domain: "", status: "running", health_check_mode: "http", rate_limit_rps: 0,
        compress: 0, internal_protocol: "http", placement: '{"1":2}', virtual_ip: "10.96.0.2" },
    ]);
    expect(db.query("SELECT container_name, status, host_port FROM replicas").get())
      .toEqual({ container_name: "db", status: "running", host_port: 10001 });
    expect(db.query("SELECT name, ipv4, status FROM servers").get()).toEqual({ name: "srv", ipv4: "203.0.113.5", status: "ready" });
    expect(db.query("SELECT name, status FROM stacks").get()).toEqual({ name: "bc", status: "running" });
    expect(db.query("SELECT permission FROM user_permissions").all()).toEqual([{ permission: "apps.deploy" }]);

    // The recreated trigger still bumps the revision on declared-config edits.
    const before = (db.query("SELECT config_revision FROM apps WHERE id = 2").get() as { config_revision: number }).config_revision;
    db.run("UPDATE apps SET rate_limit_rps = 10 WHERE id = 2");
    expect(db.query("SELECT config_revision FROM apps WHERE id = 2").get()).toEqual({ config_revision: before + 1 });
  });

  test("migration 113 repairs committed manifest paths for webhook builds", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    db.run(
      "INSERT INTO apps (name, domain, image_ref, last_manifest_path, manifest_path) VALUES ('legacy-build', '', ?, 'services/api/.ocd-deploy.json', NULL)",
      [IMAGE_REF],
    );

    migrations.find((migration) => migration.version === 113)!.up(db);

    expect(db.query("SELECT manifest_path FROM apps WHERE name = 'legacy-build'").get())
      .toEqual({ manifest_path: "services/api/.ocd-deploy.json" });
  });

  test("adds ssh_host_key column to servers", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    // Should not throw when querying the new column
    db.run("INSERT INTO servers (name, provider_id, ssh_host_key) VALUES ('test', '123', 'key-data')");
    const server = db.query("SELECT ssh_host_key FROM servers WHERE provider_id = '123'").get() as any;
    expect(server.ssh_host_key).toBe("key-data");
  });

  test("creates deployment_history table", () => {
    const db = freshDb();
    runMigrations(db);
    // Insert a server and app first for the FK
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (name, domain, image_ref) VALUES ('app1', 'app.com', ?)", [IMAGE_REF]);
    db.run("INSERT INTO deployment_history (app_id, image_tag, git_commit) VALUES (1, 'app:latest', 'abc123')");
    const dep = db.query("SELECT * FROM deployment_history WHERE app_id = 1").get() as any;
    expect(dep.image_tag).toBe("app:latest");
    expect(dep.git_commit).toBe("abc123");
  });

  test("adds volume_id and volume_mount columns to apps", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (name, domain, image_ref, volume_id, volume_mount) VALUES ('app1', 'app.com', ?, 'vol-123', '/mnt/data:/data')", [IMAGE_REF]);
    const app = db.query("SELECT volume_id, volume_mount FROM apps WHERE name = 'app1'").get() as any;
    expect(app.volume_id).toBe("vol-123");
    expect(app.volume_mount).toBe("/mnt/data:/data");
  });

  test("is idempotent — running twice does not error", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    runMigrations(db); // Should not throw
    const row = db.query("SELECT version FROM schema_version").get() as any;
    expect(row.version).toBeGreaterThan(0);
  });

  test("migration 94 persists revision attestations, endpoint state, attempts, and port claims", () => {
    const db = freshDb();
    runMigrations(db);
    const replicaCols = (db.query("PRAGMA table_info(replicas)").all() as any[]).map((c) => c.name);
    expect(replicaCols).toContain("desired_image_digest");
    expect(replicaCols).toContain("env_hash");
    expect(replicaCols).toContain("attested_at");
    const appCols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    expect(appCols).toContain("public_endpoint_status");
    const logCols = (db.query("PRAGMA table_info(operation_logs)").all() as any[]).map((c) => c.name);
    expect(logCols).toContain("attempt");
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='port_reservations'").get()).toBeTruthy();
  });

  test("migration 14 drops apps.server_id and apps.host_port cleanly with migration-8 data", () => {
    const db = freshDb();
    // Pre-seed an app at the legacy schema before any migrations have run.
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'app1', 'a.com', 'https://x.git')");
    runMigrationsWithImageCutover(db);
    // After migration 14, server_id/host_port should not exist on apps.
    const cols = db.query("PRAGMA table_info(apps)").all() as any[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).not.toContain("server_id");
    expect(colNames).not.toContain("host_port");
    // App row preserved.
    const app = db.query("SELECT id, name FROM apps WHERE id = 1").get() as any;
    expect(app?.name).toBe("app1");
    // Migration 8 should have created a corresponding replica for the app.
    const replica = db.query("SELECT * FROM replicas WHERE app_id = 1").get() as any;
    expect(replica).toBeTruthy();
    expect(replica.server_id).toBe(1);
  });

  test("migration 105 removes build/webhook state and gives the panel an immutable image", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO servers (name, provider_id) VALUES ('s1', 'h-panel')");
    db.run(
      "INSERT INTO panel (id, server_id, name, domain, image_ref, container_port, host_port) VALUES (1, 1, 'p', 'p.example.com', ?, 3000, 3001)",
      [IMAGE_REF],
    );
    const panelCols = (db.query("PRAGMA table_info(panel)").all() as any[]).map((c) => c.name);
    expect(panelCols).toContain("image_ref");
    expect(panelCols).not.toContain("git_repo");
    expect(panelCols).not.toContain("webhook_secret");
    const appCols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    expect(appCols).toContain("image_ref");
    expect(appCols).not.toContain("git_repo");
    expect(appCols).not.toContain("source_mode");
    expect(appCols).not.toContain("build_cache_ref");
    expect(appCols.some((column) => column.startsWith("webhook"))).toBe(false);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_candidates'").get()).toBeNull();
  });

  test("migration 107 converts dedicated GitHub runners into OCD build workers", () => {
    const db = freshDb();
    runMigrations(db);
    const columns = (db.query("PRAGMA table_info(build_workers)").all() as any[]).map((column) => column.name);
    expect(columns).toContain("server_id");
    expect(columns).toContain("worker_version");
    expect(columns).not.toContain("scope_url");
    expect(columns.some((column) => column.includes("token"))).toBe(false);
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='github_runners'").get()).toBeNull();

    const sourceColumns = (db.query("PRAGMA table_info(build_sources)").all() as any[]).map(
      (column) => column.name,
    );
    expect(sourceColumns).toContain("repository");
    expect(sourceColumns).toContain("webhook_enabled");
    expect(sourceColumns).toContain("worker_id");
  });

  test("migration 108 adds durable build-worker capacity leases", () => {
    const db = freshDb();
    runMigrations(db);
    const columns = (db.query("PRAGMA table_info(build_workers)").all() as any[]).map((column) => column.name);
    expect(columns).toContain("draining");
    expect(columns).toContain("disk_free_bytes");
    expect(columns).toContain("last_used_at");
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='build_worker_leases'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='build_worker_leases_expiry'").get()).toBeTruthy();
  });

  test("migration 109 persists verified build artifacts and checkpoints", () => {
    const db = freshDb();
    runMigrations(db);
    const artifactColumns = (db.query("PRAGMA table_info(build_artifacts)").all() as any[]).map(
      (column) => column.name,
    );
    expect(artifactColumns).toEqual([
      "operation_id",
      "target_name",
      "image_ref",
      "repository",
      "commit_sha",
      "worker_id",
      "verified_at",
    ]);
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='build_artifacts_image_ref_immutable'",
    ).get()).toBeTruthy();
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='build_result_checkpoints'",
    ).get()).toBeTruthy();
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='build_result_checkpoints_source'",
    ).get()).toBeTruthy();
  });

  test("migration 110 persists build-source webhook deliveries", () => {
    const db = freshDb();
    runMigrations(db);
    const columns = (db.query("PRAGMA table_info(build_source_deliveries)").all() as any[]).map(
      (column) => column.name,
    );
    expect(columns).toEqual([
      "id",
      "source_id",
      "delivery_id",
      "commit_sha",
      "event_at",
      "received_at",
      "operation_id",
      "status",
      "superseded_by",
    ]);
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='build_source_deliveries_source_event'",
    ).get()).toBeTruthy();
    expect(db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='build_source_deliveries_source_status'",
    ).get()).toBeTruthy();
  });

  test("skips already applied migrations", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db);
    const v1 = (db.query("SELECT version FROM schema_version").get() as any).version;
    runMigrations(db);
    const v2 = (db.query("SELECT version FROM schema_version").get() as any).version;
    expect(v1).toBe(v2);
  });

  test("migration 60 backfills unique sequential internal ports", () => {
    const db = freshDb();
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a1', 'a1.com', 'https://x.git')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a2', 'a2.com', 'https://x.git')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a3', 'a3.com', 'https://x.git')");
    runMigrationsWithImageCutover(db);
    const rows = db.query("SELECT internal_port FROM apps ORDER BY id ASC").all() as any[];
    expect(rows.map((r) => r.internal_port)).toEqual([20000, 20001, 20002]);
  });

  test("migration 60 unique index rejects duplicate internal ports but allows 0", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('a1', 'a1.com', ?, 20005)", [IMAGE_REF]);
    expect(() =>
      db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('a2', 'a2.com', ?, 20005)", [IMAGE_REF]),
    ).toThrow();
    // The index is partial (internal_port > 0) — unallocated rows don't collide.
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('a3', 'a3.com', ?, 0)", [IMAGE_REF]);
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('a4', 'a4.com', ?, 0)", [IMAGE_REF]);
  });

  test("migration 78 backfills unique sequential virtual IPs", () => {
    const db = freshDb();
    db.run("INSERT INTO servers (name, hetzner_id) VALUES ('s1', 'h1')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a1', 'a1.com', 'https://x.git')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a2', 'a2.com', 'https://x.git')");
    db.run("INSERT INTO apps (server_id, name, domain, git_repo) VALUES (1, 'a3', 'a3.com', 'https://x.git')");
    runMigrationsWithImageCutover(db);
    const rows = db.query("SELECT virtual_ip FROM apps ORDER BY id ASC").all() as any[];
    expect(rows.map((r) => r.virtual_ip)).toEqual(["10.96.0.1", "10.96.0.2", "10.96.0.3"]);
  });

  test("migration 78 unique index rejects duplicate virtual IPs but allows ''", () => {
    const db = freshDb();
    runMigrations(db);
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port, virtual_ip) VALUES ('a1', 'a1.com', ?, 20005, '10.96.0.5')", [IMAGE_REF]);
    expect(() =>
      db.run("INSERT INTO apps (name, domain, image_ref, internal_port, virtual_ip) VALUES ('a2', 'a2.com', ?, 20006, '10.96.0.5')", [IMAGE_REF]),
    ).toThrow();
    // The index is partial (virtual_ip != '') — unallocated rows don't collide.
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('a3', 'a3.com', ?, 20007)", [IMAGE_REF]);
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('a4', 'a4.com', ?, 20008)", [IMAGE_REF]);
  });

  test("migration 61 blanks domains of private apps only", () => {
    const db = freshDb();
    runMigrations(db);
    // Re-apply migration 61 against post-migration rows (runMigrations already
    // ran it on an empty table).
    db.run("INSERT INTO apps (name, domain, image_ref, public, internal_port) VALUES ('pub', 'pub.example.com', ?, 1, 20000)", [IMAGE_REF]);
    db.run("INSERT INTO apps (name, domain, image_ref, public, internal_port) VALUES ('priv', 'priv.example.com', ?, 0, 20001)", [IMAGE_REF]);
    migrations.find((m) => m.version === 61)!.up(db);
    const pub = db.query("SELECT domain FROM apps WHERE name = 'pub'").get() as any;
    const priv = db.query("SELECT domain FROM apps WHERE name = 'priv'").get() as any;
    expect(pub.domain).toBe("pub.example.com");
    expect(priv.domain).toBe("");
  });

  test("migration 62 backfills bcrypt hashes for password-protected apps only", () => {
    // Minimal pre-62 apps table (the migration only touches auth_password*).
    const db = new Database(":memory:");
    db.run("CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, auth_password TEXT NOT NULL DEFAULT '')");
    db.run("INSERT INTO apps (name, auth_password) VALUES ('gated', 'hunter2')");
    db.run("INSERT INTO apps (name) VALUES ('open')");
    migrations.find((m) => m.version === 62)!.up(db);
    const gated = db.query("SELECT auth_password_hash FROM apps WHERE name = 'gated'").get() as any;
    const open = db.query("SELECT auth_password_hash FROM apps WHERE name = 'open'").get() as any;
    expect(gated.auth_password_hash.startsWith("$2")).toBe(true);
    expect(Bun.password.verifySync("hunter2", gated.auth_password_hash)).toBe(true);
    expect(open.auth_password_hash).toBe("");
  });

  test("migration 66 drops apps.auth_password but keeps auth_password_hash", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 124);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    // The plaintext column is gone; the bcrypt hash is the sole source of truth.
    expect(cols).not.toContain("auth_password");
    expect(cols).toContain("auth_password_hash");
  });

  test("migration 67 adds internal_protocol defaulting to http", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    expect(cols).toContain("internal_protocol");
    // New rows that don't specify it get the column default.
    db.run("INSERT INTO apps (name, domain, image_ref, internal_port) VALUES ('defapp', 'd.example.com', ?, 20000)", [IMAGE_REF]);
    const row = db.query("SELECT internal_protocol FROM apps WHERE name = 'defapp'").get() as any;
    expect(row.internal_protocol).toBe("http");
  });

  test("migration 67 backfills internal_protocol from health_check (http when 1, tcp when 0)", () => {
    // Minimal pre-67 apps table (the migration only touches internal_protocol
    // and reads health_check), like the migration-62 test.
    const db = new Database(":memory:");
    db.run("CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, health_check INTEGER NOT NULL DEFAULT 1)");
    db.run("INSERT INTO apps (name, health_check) VALUES ('httpapp', 1)");
    db.run("INSERT INTO apps (name, health_check) VALUES ('tcpapp', 0)");
    migrations.find((m) => m.version === 67)!.up(db);
    const httpApp = db.query("SELECT internal_protocol FROM apps WHERE name = 'httpapp'").get() as any;
    const tcpApp = db.query("SELECT internal_protocol FROM apps WHERE name = 'tcpapp'").get() as any;
    expect(httpApp.internal_protocol).toBe("http");
    expect(tcpApp.internal_protocol).toBe("tcp");
  });

  test("migration 68 drops apps.wake_token (the browser wake page is gone)", () => {
    const db = freshDb();
    runMigrations(db);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    // The token authenticated the old browser wake page; the hold-and-forward
    // waker needs none, so the column is dropped.
    expect(cols).not.toContain("wake_token");
  });

  // Minimal pre-79 schema slice: migration 79 reads apps(name, internal_port,
  // internal_protocol, container_port) and rewrites environments.env_vars.
  function pre79Db(): Database {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, internal_port INTEGER NOT NULL DEFAULT 0, internal_protocol TEXT NOT NULL DEFAULT 'http', container_port INTEGER NOT NULL DEFAULT 3000)",
    );
    db.run(
      `CREATE TABLE environments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, env_vars TEXT NOT NULL DEFAULT '{"version":2,"entries":[]}')`,
    );
    return db;
  }

  test("migration 79 rewrites stored legacy internal URLs to the canonical port-less / container-port forms", () => {
    const db = pre79Db();
    db.run("INSERT INTO apps (name, internal_port, internal_protocol, container_port) VALUES ('web', 20010, 'http', 3000)");
    db.run("INSERT INTO apps (name, internal_port, internal_protocol, container_port) VALUES ('pg', 20009, 'tcp', 5432)");
    const envVars = JSON.stringify({
      version: 2,
      entries: [
        { key: "WEB_URL", value: "http://web.ocd.internal:20010", secret: false, updated_at: "2026-01-01" },
        { key: "PG_URL", value: "tcp://pg.ocd.internal:20009", secret: false, updated_at: "2026-01-01" },
        // A tcp-schemed URL for an http app (or vice versa) still maps to the
        // target app's canonical form.
        { key: "WEB_TCP", value: "tcp://web.ocd.internal:20010", secret: false, updated_at: "2026-01-01" },
        // Not an exact match — value embeds the URL, left alone.
        { key: "COMPOSITE", value: "http://web.ocd.internal:20010/api", secret: false, updated_at: "2026-01-01" },
        { key: "OTHER", value: "hello", secret: false, updated_at: "2026-01-01" },
      ],
    });
    db.run("INSERT INTO environments (name, env_vars) VALUES ('stack-env', ?)", [envVars]);

    migrations.find((m) => m.version === 79)!.up(db);

    const row = db.query("SELECT env_vars FROM environments WHERE name = 'stack-env'").get() as any;
    const entries = JSON.parse(row.env_vars).entries;
    const byKey = Object.fromEntries(entries.map((e: any) => [e.key, e.value]));
    expect(byKey.WEB_URL).toBe("http://web.ocd.internal");
    expect(byKey.PG_URL).toBe("tcp://pg.ocd.internal:5432");
    expect(byKey.WEB_TCP).toBe("http://web.ocd.internal");
    expect(byKey.COMPOSITE).toBe("http://web.ocd.internal:20010/api");
    expect(byKey.OTHER).toBe("hello");
  });

  test("migration 79 leaves encrypted (secret) values untouched", () => {
    const db = pre79Db();
    db.run("INSERT INTO apps (name, internal_port, internal_protocol, container_port) VALUES ('web', 20010, 'http', 3000)");
    const secretEntry = {
      key: "SECRET_URL",
      // Pathological: a secret whose plaintext field carries the legacy URL —
      // secrets must never be rewritten regardless.
      value: "http://web.ocd.internal:20010",
      encrypted_value: "deadbeef",
      iv: "cafe",
      secret: true,
      updated_at: "2026-01-01",
    };
    const envVars = JSON.stringify({ version: 2, entries: [secretEntry] });
    db.run("INSERT INTO environments (name, env_vars) VALUES ('sec-env', ?)", [envVars]);

    migrations.find((m) => m.version === 79)!.up(db);

    const row = db.query("SELECT env_vars FROM environments WHERE name = 'sec-env'").get() as any;
    // Byte-identical: nothing in the row changed.
    expect(row.env_vars).toBe(envVars);
    expect(JSON.parse(row.env_vars).entries[0]).toEqual(secretEntry);
  });

  test("migration 80 renames env_label/sibling_of to target/target_of on the full schema", () => {
    const db = freshDb();
    runMigrationsWithImageCutover(db, 124);
    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    expect(cols).toContain("target");
    expect(cols).toContain("target_of");
    expect(cols).not.toContain("env_label");
    expect(cols).not.toContain("sibling_of");
    // Insert/read round-trip through the renamed columns.
    db.run(
      "INSERT INTO apps (name, domain, image_ref, internal_port, virtual_ip, target) VALUES ('prod80', 'p.example.com', ?, 20080, '10.96.0.80', 'production')",
      [IMAGE_REF],
    );
    const parent = db.query("SELECT id FROM apps WHERE name = 'prod80'").get() as any;
    db.run(
      "INSERT INTO apps (name, domain, image_ref, internal_port, virtual_ip, target, target_of) VALUES ('prod80-staging', '', ?, 20081, '10.96.0.81', 'staging', ?)",
      [IMAGE_REF, parent.id],
    );
    const child = db.query("SELECT target, target_of FROM apps WHERE name = 'prod80-staging'").get() as any;
    expect(child.target).toBe("staging");
    expect(child.target_of).toBe(parent.id);
    // Defaults are preserved by the rename: '' and NULL.
    const std = db.query("SELECT target, target_of FROM apps WHERE name = 'prod80'").get() as any;
    expect(std.target).toBe("production");
    expect(std.target_of).toBeNull();
  });

  test("migration 80 preserves pre-80 env_label/sibling_of values under the new names", () => {
    // Minimal pre-80 apps table slice: migration 80 only renames the two
    // columns added by migration 77 (same pattern as the migration-62/67 tests).
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, env_label TEXT NOT NULL DEFAULT '', sibling_of INTEGER)",
    );
    db.run("INSERT INTO apps (name, env_label) VALUES ('prod', 'production')");
    db.run("INSERT INTO apps (name, env_label, sibling_of) VALUES ('prod-staging', 'staging', 1)");
    db.run("INSERT INTO apps (name) VALUES ('standalone')");

    migrations.find((m) => m.version === 80)!.up(db);

    const cols = (db.query("PRAGMA table_info(apps)").all() as any[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["target", "target_of"]));
    expect(cols).not.toContain("env_label");
    expect(cols).not.toContain("sibling_of");

    const rows = db.query("SELECT name, target, target_of FROM apps ORDER BY id").all() as any[];
    expect(rows).toEqual([
      { name: "prod", target: "production", target_of: null },
      { name: "prod-staging", target: "staging", target_of: 1 },
      { name: "standalone", target: "", target_of: null },
    ]);
  });

  test("migration 79 is a no-op on malformed or non-v2 env_vars", () => {
    const db = pre79Db();
    db.run("INSERT INTO apps (name, internal_port, internal_protocol, container_port) VALUES ('web', 20010, 'http', 3000)");
    db.run("INSERT INTO environments (name, env_vars) VALUES ('bad', 'not json')");
    db.run(`INSERT INTO environments (name, env_vars) VALUES ('old', '{"KEY":"http://web.ocd.internal:20010"}')`);
    migrations.find((m) => m.version === 79)!.up(db);
    expect((db.query("SELECT env_vars FROM environments WHERE name = 'bad'").get() as any).env_vars).toBe("not json");
    expect((db.query("SELECT env_vars FROM environments WHERE name = 'old'").get() as any).env_vars).toBe(
      '{"KEY":"http://web.ocd.internal:20010"}',
    );
  });
});
