import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { encryptArchive, sha256, MAX_ARCHIVE_BYTES, type PanelArchive } from "./archive.ts";

const input = workerData as { snapshotPath: string; databasePath?: string; key: string; archive: Omit<PanelArchive, "database" | "databaseSha256"> };
try {
  if (input.databasePath) {
    const live = new Database(input.databasePath, { readonly: true });
    try {
      live.run("PRAGMA busy_timeout = 5000");
      live.run(`VACUUM INTO '${input.snapshotPath.replace(/'/g, "''")}'`);
    } finally { live.close(); }
    const snapshot = new Database(input.snapshotPath, { readonly: true });
    try {
      const check = snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string };
      if (check.integrity_check !== "ok") throw new Error("Invalid snapshot");
    } finally { snapshot.close(); }
  }
  if (statSync(input.snapshotPath).size > MAX_ARCHIVE_BYTES / 2) throw new Error("Snapshot exceeds backup size limit");
  const database = readFileSync(input.snapshotPath);
  const encrypted = encryptArchive({ ...input.archive, database: database.toString("base64"), databaseSha256: sha256(database) }, input.key);
  const bytes = new Uint8Array(encrypted);
  parentPort!.postMessage(bytes, [bytes.buffer]);
} catch {
  // Never propagate credentials or backup contents across an error boundary.
  throw new Error("Panel archive encryption failed");
}
