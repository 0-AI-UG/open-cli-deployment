import { useTempDataDir } from "../test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import path from "path";

import * as db from "../db.ts";
import {
  ALL_PERMISSIONS,
  getUserPermissions,
  hasPermission,
  setUserPermissions,
} from "./users.ts";
import { migrations } from "../migrations.ts";
import { createToken, authenticateRequest } from "../../server/lib/auth.ts";
import { assertCliAccess } from "../../server/lib/permissions.ts";
import { PermissionError } from "../../server/lib/errors.ts";

let seq = 0;
function makeUser(opts: { isAdmin?: boolean } = {}): string {
  const id = `u-${Date.now()}-${seq++}`;
  db.insertUser({ id, username: id, password_hash: "x", is_admin: opts.isAdmin });
  return id;
}

describe("hasPermission", () => {
  test("a grant satisfies its permission and nothing else", () => {
    const user = makeUser();
    setUserPermissions(user, ["apps.restart"]);
    expect(hasPermission(user, "apps.restart")).toBe(true);
    expect(hasPermission(user, "apps.destroy")).toBe(false);
  });

  test("a user with no grants at all is denied", () => {
    expect(hasPermission(makeUser(), "apps.view")).toBe(false);
  });

  test("an unknown user id is denied rather than throwing", () => {
    expect(hasPermission("nobody", "apps.view")).toBe(false);
  });
});

describe("setUserPermissions", () => {
  test("replaces the previous set and ignores duplicates", () => {
    const user = makeUser();
    setUserPermissions(user, ["apps.view", "apps.logs", "apps.logs"]);
    expect(getUserPermissions(user).sort()).toEqual(["apps.logs", "apps.view"]);
    setUserPermissions(user, ["apps.view"]);
    expect(getUserPermissions(user)).toEqual(["apps.view"]);
  });
});

describe("is_admin", () => {
  test("bypasses every permission with zero grants", () => {
    const admin = makeUser({ isAdmin: true });
    expect(getUserPermissions(admin)).toEqual([]);
    for (const p of ALL_PERMISSIONS) expect(hasPermission(admin, p)).toBe(true);
    // Even a permission that does not exist.
    expect(hasPermission(admin, "does.not.exist")).toBe(true);
  });
});

test("migration 121 preserves accounts holding every previous global permission", () => {
  const d = new Database(":memory:");
  d.run(`CREATE TABLE user_permissions (
    user_id TEXT NOT NULL, permission TEXT NOT NULL,
    scope_type TEXT NOT NULL DEFAULT 'global', scope_id TEXT
  )`);
  const oldPermissions = [
    ...ALL_PERMISSIONS.filter((permission) =>
      !["apps.storage.bind", "apps.notifications.bind", "operations.manage"].includes(permission)),
    // Retired after 121; still part of the catalog that migration froze.
    "apps.promote", "stacks.promote", "apps.rollback",
  ];
  const insert = d.query("INSERT INTO user_permissions (user_id, permission, scope_type) VALUES (?, ?, 'global')");
  for (const permission of oldPermissions) insert.run("full", permission);
  for (const permission of oldPermissions.slice(1)) insert.run("partial", permission);
  const migration = migrations.find((entry) => entry.version === 121)!;
  migration.up(d);
  const added = d.query("SELECT permission FROM user_permissions WHERE user_id = ? AND permission IN ('apps.storage.bind','apps.notifications.bind','operations.manage')");
  expect((added.all("full") as Array<{ permission: string }>).map((row) => row.permission).sort()).toEqual([
    "apps.notifications.bind", "apps.storage.bind", "operations.manage",
  ]);
  expect(added.all("partial")).toEqual([]);
  d.close();
});

describe("migration 85", () => {
  /** A DB in the pre-85 shape: flat user_permissions, no scope columns. */
  function legacyDb(): Database {
    const d = new Database(":memory:");
    d.run("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL)");
    d.run(`CREATE TABLE user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      UNIQUE(user_id, permission)
    )`);
    return d;
  }

  /** The production shape: the real connection runs `PRAGMA foreign_keys = ON`
   *  (connection.ts), and user_permissions carries an FK to users. */
  function legacyDbWithFk(): Database {
    const d = new Database(":memory:");
    d.run("PRAGMA foreign_keys = ON");
    d.run("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL)");
    d.run(`CREATE TABLE user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      UNIQUE(user_id, permission)
    )`);
    return d;
  }

  function runMigration85(d: Database): void {
    const m = migrations.find((x) => x.version === 85);
    expect(m).toBeTruthy();
    m!.up(d);
  }

  function permsOf(d: Database, userId: string): string[] {
    return (
      d
        .query("SELECT permission FROM user_permissions WHERE user_id = ? AND scope_type = 'global'")
        .all(userId) as Array<{ permission: string }>
    )
      .map((r) => r.permission)
      .sort();
  }

  // Regression: this took the production panel down. The live DB held 24 grants
  // belonging to a user that had been deleted — the old table declared the FK
  // but was written while enforcement was off, so the rows outlived their user.
  // Carrying them into the rebuilt table tripped SQLITE_CONSTRAINT_FOREIGNKEY,
  // failing the migration and crash-looping the panel on every boot.
  test("orphaned grants whose user was deleted do not fail the migration", () => {
    const d = legacyDbWithFk();
    d.run("INSERT INTO users (id, username) VALUES ('live', 'admin')");
    d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('live', 'apps.deploy')");
    // Sneak past the FK the way production did, then leave the rows dangling.
    d.run("PRAGMA foreign_keys = OFF");
    d.run("INSERT INTO users (id, username) VALUES ('ghost', 'deleted')");
    d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('ghost', 'apps.deploy')");
    d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('ghost', 'servers.view')");
    d.run("DELETE FROM users WHERE id = 'ghost'");
    d.run("PRAGMA foreign_keys = ON");

    expect(() => runMigration85(d)).not.toThrow();

    // The live user is carried over and widened; the ghost's rows are gone.
    expect(permsOf(d, "live")).toContain("apps.deploy");
    expect(permsOf(d, "live")).toContain("cli.access");
    expect(permsOf(d, "ghost")).toEqual([]);
    const orphans = d
      .query("SELECT COUNT(*) AS n FROM user_permissions WHERE user_id NOT IN (SELECT id FROM users)")
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  test("servers.view widens into the six read permissions and is itself dropped", () => {
    const d = legacyDb();
    d.run("INSERT INTO users (id, username) VALUES ('u1', 'reader')");
    d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('u1', 'servers.view')");

    runMigration85(d);

    const perms = permsOf(d, "u1");
    for (const p of [
      "fleet.view",
      "apps.view",
      "services.view",
      "environments.view",
      "metrics.view",
      "operations.view",
    ]) {
      expect(perms).toContain(p);
    }
    expect(perms).not.toContain("servers.view");
  });

  test("apps.env is removed entirely", () => {
    const d = legacyDb();
    d.run("INSERT INTO users (id, username) VALUES ('u1', 'a')");
    d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('u1', 'apps.env')");

    runMigration85(d);

    expect(permsOf(d, "u1")).not.toContain("apps.env");
  });

  test("every user gains cli.access, including one with no grants at all", () => {
    const d = legacyDb();
    d.run("INSERT INTO users (id, username) VALUES ('u1', 'a'), ('u2', 'b')");
    d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('u1', 'apps.logs')");

    runMigration85(d);

    expect(permsOf(d, "u1")).toContain("cli.access");
    expect(permsOf(d, "u2")).toEqual(["cli.access"]);
  });

  test("carried-over grants land as global scope, and every surviving name is in the catalog", () => {
    const d = legacyDb();
    d.run("INSERT INTO users (id, username) VALUES ('u1', 'a')");
    for (const p of [
      "servers.view",
      "servers.delete",
      "apps.deploy",
      "apps.redeploy",
      "apps.logs",
      "stacks.deploy",
      "scaling.manage",
      "volumes.manage",
      "terminal.access",
      "environments.manage",
      "resources.create",
      "apps.env",
    ]) {
      d.run("INSERT INTO user_permissions (user_id, permission) VALUES ('u1', ?)", [p]);
    }

    runMigration85(d);

    const rows = d
      .query("SELECT permission, scope_type, scope_id FROM user_permissions WHERE user_id = 'u1'")
      .all() as Array<{ permission: string; scope_type: string; scope_id: string | null }>;
    for (const r of rows) {
      expect(r.scope_type).toBe("global");
      expect(r.scope_id).toBeNull();
      // Migration 85 legitimately created these historical grants; later
      // migrations remove them when their corresponding surface is retired.
      expect([
        ...(ALL_PERMISSIONS as readonly string[]),
        "services.view",
        "volumes.create", "volumes.attach", "volumes.detach", "volumes.resize",
        "apps.promote", "stacks.promote", "apps.rollback",
      ]).toContain(r.permission);
    }
    // Spot-check a few of the splits.
    const perms = permsOf(d, "u1");
    expect(perms).toContain("servers.manage"); // from servers.delete
    expect(perms).toContain("apps.deploy"); // from apps.redeploy/scaling.manage
    expect(perms).toContain("scaling.migrate"); // from scaling.manage
    expect(perms).toContain("volumes.resize"); // from volumes.manage
    expect(perms).toContain("terminal.host"); // from terminal.access
    expect(perms).toContain("environments.secrets"); // from environments.manage
    expect(perms).toContain("servers.create"); // from resources.create
  });
});

// `assertCliAccess` is the whole of the CLI gate; requirePermission and
// requireAuthenticated do nothing but call it.
describe("cli.access enforcement (assertCliAccess)", () => {
  const payload = (userId: string, cli: boolean) => ({
    userId,
    username: userId,
    ...(cli ? { client: "cli" as const } : {}),
  });

  test("a CLI token is rejected when the user lacks cli.access, even holding the permission", () => {
    const user = makeUser();
    setUserPermissions(user, ["apps.view"]);

    expect(() => assertCliAccess(payload(user, true))).toThrow(/CLI access is not enabled/i);
    try {
      assertCliAccess(payload(user, true));
    } catch (e) {
      // A 403, not an auth failure.
      expect(e).toBeInstanceOf(PermissionError);
    }
  });

  test("a CLI token passes once cli.access is granted", () => {
    const user = makeUser();
    setUserPermissions(user, ["apps.view", "cli.access"]);
    expect(() => assertCliAccess(payload(user, true))).not.toThrow();
  });

  test("a non-CLI token is unaffected by cli.access", () => {
    const user = makeUser();
    setUserPermissions(user, ["apps.view"]);
    expect(() => assertCliAccess(payload(user, false))).not.toThrow();
  });

  test("an admin CLI token is never blocked", () => {
    const admin = makeUser({ isAdmin: true });
    expect(() => assertCliAccess(payload(admin, true))).not.toThrow();
  });

  test("cli.access does not itself grant any permission", () => {
    const user = makeUser();
    setUserPermissions(user, ["cli.access"]);
    expect(hasPermission(user, "apps.destroy")).toBe(false);
  });

  test("a real signed request still carries the client tag the gate reads", async () => {
    const user = makeUser();
    const token = await createToken({ userId: user, username: user, client: "cli" });
    const req = new Request("http://x/api/apps", { headers: { Authorization: `Bearer ${token}` } });
    expect((await authenticateRequest(req)).client).toBe("cli");
  });
});

describe("route permission catalogue", () => {
  // Typo guard: any permission string a route asks for must exist in
  // ALL_PERMISSIONS, otherwise the check can never be satisfied by a grant.
  test("every permission literal used in src/server/routes/*.ts is a known permission", () => {
    const dir = path.join(import.meta.dir, "../../server/routes");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);

    const patterns = [
      // requirePermission(req, "perm", ...) — first arg is an identifier/member expr.
      /requirePermission\(\s*[A-Za-z_$][\w$.]*\s*,\s*["'`]([^"'`]+)["'`]/g,
      // route metadata: { permission: "perm" }
      /\bpermission:\s*["'`]([^"'`]+)["'`]/g,
    ];

    const known = new Set<string>(ALL_PERMISSIONS as readonly string[]);
    const offenders: string[] = [];
    let found = 0;

    for (const file of files) {
      const src = readFileSync(path.join(dir, file), "utf8");
      for (const re of patterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          found++;
          if (!known.has(m[1])) offenders.push(`${file}: ${m[1]}`);
        }
      }
    }

    // Sanity: the scan actually found literals (guards against a dead regex).
    expect(found).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
