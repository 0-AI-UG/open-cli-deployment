import { test, expect, mock, beforeEach } from "bun:test";
import database, * as db from "./db.ts";
const realS3 = await import("../engine/object-storage/s3.ts");
mock.module("../engine/object-storage/s3.ts", () => ({ ...realS3,
  getS3Credentials: async () => ({ endpoint: "https://fsn1.your-objectstorage.com", region: "fsn1", accessKey: "access", secretKey: "secret" }),
  listBuckets: async () => [{ name: "shared-bucket" }],
}));
const storage = await import("./object-storage.ts");
beforeEach(() => {
if (db.getPanel()) return;
database.run("PRAGMA foreign_keys=OFF");
db.insertPanel({ server_id: 1, name: "panel", domain: "panel.example.com", image_ref: `ghcr.io/test/panel@sha256:${"a".repeat(64)}`, container_port: 3001, host_port: 3001 });
database.run("PRAGMA foreign_keys=ON");
});
const input = { primary: { bucket: "shared-bucket", prefix: "app/", permissions: ["read", "write"] as Array<"read" | "write"> } };

test("resolution is stable", () => {
  const first = storage.resolveStorageBindings(input);
  expect(JSON.stringify(storage.resolveStorageBindings(first))).toBe(JSON.stringify(first));
});
test("separate apps get separate encrypted grants; retries keep their tokens stable", async () => {
  const bindings = storage.resolveStorageBindings(input);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, bindings);
  storage.saveAppStorage(101, bindings);
  const before = await storage.appStorageEnv(101);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, bindings);
  expect(await storage.appStorageEnv(101)).toEqual(before);
  await storage.prepareStorageBindings({ id: 102, name: "two" }, bindings);
  expect((await storage.appStorageEnv(102, bindings)).OCD_STORAGE_TOKEN).not.toBe(before.OCD_STORAGE_TOKEN);
  expect(JSON.stringify(storage.getStorageGrants())).not.toContain(before.OCD_STORAGE_TOKEN);
  expect(storage.getStorageGrants().find(g => g.appId === 101)?.methods).toEqual(["GET", "HEAD", "PUT"]);
});
test("rotation retains old grant until rollout finalization; multiple bindings get separate grants", async () => {
  const previous = storage.resolveStorageBindings(input);
  await storage.prepareStorageBindings({ id: 101, name: "one" }, previous);
  storage.saveAppStorage(101, previous);
  const next = storage.resolveStorageBindings({ ...previous, primary: { ...previous.primary, generation: 1 }, media: { bucket: "shared-bucket", prefix: "media/", permissions: ["read"] } });
  await storage.prepareStorageBindings({ id: 101, name: "one" }, next);
  expect(storage.getStorageGrants().filter(g => g.appId === 101)).toHaveLength(3);
  const vars = await storage.appStorageEnv(101, next);
  expect(vars.OCD_MEDIA_STORAGE_TOKEN).toBeTruthy();
  expect(vars.OCD_MEDIA_STORAGE_URL).toBe("https://panel.example.com/api/storage/authorize");
  storage.saveAppStorage(101, next);
  storage.retireAppStorageGrants(101);
  expect(storage.getStorageGrants().filter(g => g.appId === 101)).toHaveLength(2);
  storage.saveAppStorage(101, {});
  storage.retireAppStorageGrants(101);
  expect(storage.getStorageGrants().filter(g => g.appId === 101)).toHaveLength(0);
});
