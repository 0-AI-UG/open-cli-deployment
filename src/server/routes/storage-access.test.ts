import { expect, test } from "bun:test";
import { authorizeObject } from "./storage-access.ts";

test("storage access fixes the prefix and rejects writes for read-only grants", () => {
  const grant = { prefix: "foody/", methods: ["GET", "HEAD"] as Array<"GET" | "HEAD"> };
  expect(authorizeObject(grant, { method: "GET", key: "uploads/a", bucket: "other-bucket", prefix: "other/" }).key).toBe("foody/uploads/a");
  expect(() => authorizeObject(grant, { method: "PUT", key: "uploads/a" })).toThrow();
  expect(() => authorizeObject(grant, { method: "GET", key: "../other/a" })).toThrow();
  expect(() => authorizeObject(grant, { method: "GET", key: "a", expiresIn: 86400 })).toThrow();
});

test("grants are tied to the Hetzner Object Storage region they were issued for", async () => {
  const db = await import("../../shared/db.ts");
  const { secretStore } = await import("../../shared/secret-store.ts");
  const { saveStorageGrants, storageTokenHash } = await import("../../shared/object-storage.ts");
  const { handleStorageAuthorize } = await import("./storage-access.ts");
  db.saveSetting("hetzner_s3_region", "nbg1");
  await secretStore.set("hetzner_s3_access_key", "access");
  await secretStore.set("hetzner_s3_secret_key", "secret");
  const token = `ocds_${"a".repeat(64)}`;
  saveStorageGrants([{ id: "grant", app: "one", reader: "one", endpoint: "https://nbg1.your-objectstorage.com", region: "nbg1", bucket: "shared-bucket", prefix: "app/", methods: ["GET"], tokenHash: storageTokenHash(token), createdAt: "now" }]);
  const request = () => new Request("https://panel.example/api/storage/authorize", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ method: "GET", key: "image.jpg" }) });
  const response = await handleStorageAuthorize(request());
  expect(response.status).toBe(200);
  expect(new URL((await response.json()).url).host).toContain("nbg1.your-objectstorage.com");
  db.saveSetting("hetzner_s3_region", "fsn1");
  expect((await handleStorageAuthorize(request())).status).toBe(409);
});

test("external readers list only named read-only grants and reject legacy tokens", async () => {
  const db = await import("../../shared/db.ts");
  const { createToken } = await import("../lib/auth.ts");
  const { getStorageGrants, saveStorageGrants, storageTokenHash } = await import("../../shared/object-storage.ts");
  const { handleStorageReaders, handleStorageAuthorize } = await import("./storage-access.ts");
  db.insertUser({ id: "reader-user", username: "reader-user", password_hash: "unused" });
  const token = await createToken({ userId: "reader-user", username: "reader-user" });
  const req = (method: string, body?: unknown) => new Request("https://panel.example/api/storage/readers", {
    method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const legacyToken = `ocds_${"b".repeat(64)}`;
  saveStorageGrants([
    { id: "cdn", app: "old-cdn", reader: "skyline-cdn", endpoint: "https://first.example.com", region: "nbg1", bucket: "media-bucket", prefix: "media/", methods: ["GET", "HEAD"], tokenHash: "same-hash", createdAt: "now" },
    { id: "writer", app: "old-writer", endpoint: "https://first.example.com", region: "nbg1", bucket: "media-bucket", prefix: "", methods: ["PUT"], tokenHash: "writer-hash", createdAt: "now" },
    { id: "legacy", app: "old-cdn", endpoint: "https://first.example.com", region: "nbg1", bucket: "media-bucket", prefix: "media/", methods: ["GET", "HEAD"], tokenHash: storageTokenHash(legacyToken), createdAt: "now" },
  ]);
  const legacyRequest = new Request("https://panel.example/api/storage/authorize", { method: "POST", headers: { authorization: `Bearer ${legacyToken}` }, body: JSON.stringify({ method: "GET", key: "image.jpg" }) });
  expect((await handleStorageAuthorize(legacyRequest)).status).toBe(401);
  const listed = await (await handleStorageReaders(req("GET"))).json();
  expect(listed).toEqual([{ id: "cdn", name: "skyline-cdn", bucket: "media-bucket", prefix: "media/", createdAt: "now" }]);
  expect(JSON.stringify(listed)).not.toContain("same-hash");
  expect((await handleStorageReaders(req("DELETE", { id: "cdn" }))).status).toBe(200);
  expect(getStorageGrants().map(g => g.id)).toEqual(["writer", "legacy"]);
});
