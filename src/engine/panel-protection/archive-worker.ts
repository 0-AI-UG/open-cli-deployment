import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { encryptArchive, sha256, type PanelArchive } from "./archive.ts";

const input = workerData as { snapshotPath: string; key: string; archive: Omit<PanelArchive, "database" | "databaseSha256"> };
try {
  const database = readFileSync(input.snapshotPath);
  const encrypted = encryptArchive({ ...input.archive, database: database.toString("base64"), databaseSha256: sha256(database) }, input.key);
  const bytes = new Uint8Array(encrypted);
  parentPort!.postMessage(bytes, [bytes.buffer]);
} catch {
  // Never propagate credentials or backup contents across an error boundary.
  throw new Error("Panel archive encryption failed");
}
