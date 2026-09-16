import { writeFile } from "node:fs/promises";
import { del, get, post } from "../api.ts";
import { table } from "../format.ts";

type Reader = { id: string; name: string; connection: string; bucket: string; prefix: string; createdAt: string; legacy: boolean };
const path = "/api/admin/storage-readers";
const option = (args: string[], name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

export async function storageReaders(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "list") {
    const readers = await get<Reader[]>(path);
    table(["ID", "NAME", "CONNECTION", "BUCKET", "PREFIX", "STATE"], readers.map(reader =>
      [reader.id, reader.name, reader.connection, reader.bucket, reader.prefix, reader.legacy ? "legacy" : "external reader"]));
    return;
  }
  if (args[0] === "adopt") {
    const name = option(args, "name");
    if (!args[1] || !name) throw new Error("Usage: ocd storage-readers adopt <legacy-grant-id> --name=<reader-name>");
    const reader = await post<Reader>(path, { adopt_id: args[1], name });
    console.log(`Adopted ${reader.id} as external reader ${reader.name}; existing token and scope are unchanged.`);
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
  throw new Error("Usage: ocd storage-readers <list|create|adopt|revoke>");
}
