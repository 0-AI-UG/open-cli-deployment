import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { encryptSnapshot } from "./archive-background.ts";
import { decryptArchive, generateRecoveryKey } from "./archive.ts";

test("backup compression leaves the request event loop responsive and preserves archive compatibility", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-background-backup-"));
  try {
    const database = randomBytes(16 * 1024 * 1024);
    const snapshotPath = path.join(dir, "deploy.db");
    writeFileSync(snapshotPath, database);
    const key = generateRecoveryKey();
    let completed = false;
    const result = encryptSnapshot({ snapshotPath, key, archive: { version: 1, createdAt: new Date().toISOString(), image: "test", schemaVersion: 1, jwtSecret: "test", ssh: {} } }).then(bytes => { completed = true; return bytes; });
    await Bun.sleep(10);
    expect(completed).toBe(false);
    const encrypted = await result;
    expect(Buffer.from(decryptArchive(encrypted, key).database, "base64").equals(database)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a large database snapshot does not require database-sized JSON copies in memory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ocd-large-backup-"));
  try {
    const snapshotPath = path.join(dir, "deploy.db");
    const fd = openSync(snapshotPath, "w");
    ftruncateSync(fd, 160 * 1024 * 1024);
    closeSync(fd);
    const before = process.resourceUsage().maxRSS;
    const encrypted = await encryptSnapshot({ snapshotPath, key: generateRecoveryKey(), archive: { version: 1, createdAt: new Date().toISOString(), image: "test", schemaVersion: 1, jwtSecret: "test", ssh: {} } });
    expect(encrypted.length).toBeGreaterThan(0);
    expect((process.resourceUsage().maxRSS - before) * 1024).toBeLessThan(128 * 1024 * 1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
