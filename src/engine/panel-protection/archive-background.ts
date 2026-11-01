import { Worker } from "node:worker_threads";
import type { PanelArchive } from "./archive.ts";

/** Compression of a production snapshot can take many seconds. Keep it off the
 * request thread, which also serves application storage authorization. */
export function encryptSnapshot(input: { snapshotPath: string; databasePath?: string; key: string; archive: Omit<PanelArchive, "database" | "databaseSha256"> }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./archive-worker.ts", import.meta.url), { workerData: input });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Panel archive worker timed out"));
    }, 120_000);
    timeout.unref();
    let received = false;
    worker.once("message", (bytes: Uint8Array) => {
      clearTimeout(timeout);
      received = true;
      resolve(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      void worker.terminate();
    });
    worker.once("error", () => { clearTimeout(timeout); reject(new Error("Panel archive encryption failed")); });
    worker.once("exit", () => {
      clearTimeout(timeout);
      if (!received) reject(new Error("Panel archive worker exited without a backup"));
    });
  });
}
