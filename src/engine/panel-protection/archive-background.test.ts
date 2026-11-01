import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
