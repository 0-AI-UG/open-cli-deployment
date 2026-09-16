import { writeFile } from "node:fs/promises";
import { del, get, post } from "../api.ts";
import { table } from "../format.ts";

type Reader = { id: string; name: string; connection: string; bucket: string; prefix: string; createdAt: string };
const path = "/api/admin/storage-readers";
const option = (args: string[], name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

export async function storageReaders(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "list") {
    const readers = await get<Reader[]>(path);
    table(["ID", "NAME", "CONNECTION", "BUCKET", "PREFIX"], readers.map(reader =>
      [reader.id, reader.name, reader.connection, reader.bucket, reader.prefix]));
    return;
  }
  if (args[0] === "create") {
    const tokenFile = option(args, "token-file");
    if (!args[1] || !args[2] || !tokenFile) throw new Error("Usage: ocd storage-readers create <name> <bucket> --token-file=<path> [--connection=<id>] [--prefix=<path/>]");
    const reader = await post<Reader & { token: string }>(path, { name: args[1], bucket: args[2],
      connection: option(args, "connection"), prefix: option(args, "prefix") ?? "" });
    try { await writeFile(tokenFile, reader.token, { mode: 0o600, flag: "wx" }); }
    catch (error) { await del(path, { id: reader.id }); throw error; }
    console.log(`Created external reader ${reader.id}. Token saved to ${tokenFile} (0600); it will not be shown again.`);
    return;
  }
  if (args[0] === "revoke" && args[1]) {
    await del(path, { id: args[1] });
    console.log("External reader revoked. Previously issued object URLs may remain usable for up to one hour.");
    return;
  }
  throw new Error("Usage: ocd storage-readers <list|create|revoke>");
}
