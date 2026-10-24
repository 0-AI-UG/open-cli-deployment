import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";

const MAGIC = Buffer.from("OCD-BACKUP-1\n");
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export type PanelArchive = {
  version: 1;
  createdAt: string;
  image: string;
  schemaVersion: number;
  jwtSecret: string;
  database: string;
  databaseSha256: string;
  ssh: Record<string, string>;
};
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export const generateRecoveryKey = () => randomBytes(32).toString("hex");
function keyBytes(key: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Recovery key must contain 64 lowercase hexadecimal characters");
  return Buffer.from(key, "hex");
}
export function encryptArchive(archive: PanelArchive, key: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(MAGIC);
  const compressed = gzipSync(JSON.stringify(archive));
  return Buffer.concat([MAGIC, iv, cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
}
export type ArchiveMetadata = Omit<PanelArchive, "database" | "databaseSha256">;
// A multiple of 3 so each chunk's base64 concatenates into the base64 of the whole file.
const STREAM_CHUNK_BYTES = 3 * 1024 * 1024;

/**
 * Builds the same archive as encryptArchive without holding the database in memory: the file is read,
 * base64-encoded, gzipped and encrypted chunk by chunk, so only the encrypted output stays resident.
 * Consecutive gzip members decompress as one stream, which keeps decryptArchive unchanged.
 */
export function encryptArchiveFromFile(metadata: ArchiveMetadata, databasePath: string, key: string): { archive: Buffer; databaseSha256: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  cipher.setAAD(MAGIC);
  const output: Buffer[] = [MAGIC, iv];
  const write = (text: string) => { output.push(cipher.update(gzipSync(text))); };
  write(`{"version":${JSON.stringify(metadata.version)},"createdAt":${JSON.stringify(metadata.createdAt)},"image":${JSON.stringify(metadata.image)},`
    + `"schemaVersion":${JSON.stringify(metadata.schemaVersion)},"jwtSecret":${JSON.stringify(metadata.jwtSecret)},"database":"`);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const fd = openSync(databasePath, "r");
  try {
    while (true) {
      let filled = 0;
      while (filled < chunk.length) {
        const read = readSync(fd, chunk, filled, chunk.length - filled, null);
        if (read === 0) break;
        filled += read;
      }
      if (filled === 0) break;
      const part = chunk.subarray(0, filled);
      hash.update(part);
      write(part.toString("base64"));
      if (filled < chunk.length) break;
    }
  } finally { closeSync(fd); }
  const databaseSha256 = hash.digest("hex");
  write(`","databaseSha256":"${databaseSha256}","ssh":${JSON.stringify(metadata.ssh)}}`);
  output.push(cipher.final(), cipher.getAuthTag());
  return { archive: Buffer.concat(output), databaseSha256 };
}
export function decryptArchive(bytes: Buffer, key: string): PanelArchive {
  if (bytes.length > MAX_ARCHIVE_BYTES || !bytes.subarray(0, MAGIC.length).equals(MAGIC) || bytes.length < MAGIC.length + 28) {
    throw new Error("Unsupported panel backup");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(key), bytes.subarray(MAGIC.length, MAGIC.length + 12));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(bytes.subarray(-16));
  let archive: PanelArchive;
  try {
    const compressed = Buffer.concat([decipher.update(bytes.subarray(MAGIC.length + 12, -16)), decipher.final()]);
    archive = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES }).toString());
  } catch { throw new Error("Backup authentication failed: incorrect recovery key or damaged archive"); }
  if (archive.version !== 1 || typeof archive.jwtSecret !== "string" || !archive.jwtSecret ||
      typeof archive.database !== "string" || !Number.isInteger(archive.schemaVersion) ||
      !archive.ssh || typeof archive.ssh !== "object" || Array.isArray(archive.ssh)) throw new Error("Invalid backup metadata");
  if (sha256(Buffer.from(archive.database, "base64")) !== archive.databaseSha256) throw new Error("Database checksum mismatch");
  for (const [name, value] of Object.entries(archive.ssh)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === ".." || typeof value !== "string") throw new Error("Invalid SSH backup entry");
  }
  return archive;
}
