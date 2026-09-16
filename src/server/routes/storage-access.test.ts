import { expect, test } from "bun:test";
import { authorizeObject } from "./storage-access.ts";

test("storage access fixes the prefix and rejects writes for read-only grants", () => {
  const grant = { prefix: "foody/", methods: ["GET", "HEAD"] as Array<"GET" | "HEAD"> };
  expect(authorizeObject(grant, { method: "GET", key: "uploads/a", bucket: "other-bucket", prefix: "other/" }).key).toBe("foody/uploads/a");
  expect(() => authorizeObject(grant, { method: "PUT", key: "uploads/a" })).toThrow();
  expect(() => authorizeObject(grant, { method: "GET", key: "../other/a" })).toThrow();
  expect(() => authorizeObject(grant, { method: "GET", key: "a", expiresIn: 86400 })).toThrow();
});

test("grants use their pinned connection after the global default changes", async () => {
  const { saveProviderConnections, saveProviderAssignments } = await import("../../shared/provider-connections.ts");
  const { secretStore } = await import("../../shared/secret-store.ts");
  const { saveStorageGrants, storageTokenHash } = await import("../../shared/object-storage.ts");
  const { handleStorageAuthorize } = await import("./storage-access.ts");
  saveProviderConnections(["first", "second"].map(id => ({ id, kind: "s3-compatible", name: id, created_at: "now", config: { endpoint: `https://${id}.example.com`, region: "nbg1" } })));
  saveProviderAssignments({ infrastructure: "", object_storage: "second" });
  await secretStore.set("provider.first.access_key", "first-access");
  await secretStore.set("provider.first.secret_key", "first-secret");
  const token = `ocds_${"a".repeat(64)}`;
  saveStorageGrants([{ id: "grant", app: "one", reader: "one", providerId: "first", endpoint: "https://first.example.com", region: "nbg1", bucket: "shared-bucket", prefix: "app/", methods: ["GET"], tokenHash: storageTokenHash(token), createdAt: "now" }]);
  const request = () => new Request("https://panel.example/api/storage/authorize", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ method: "GET", key: "image.jpg" }) });
  const response = await handleStorageAuthorize(request());
  expect(response.status).toBe(200);
  expect(new URL((await response.json()).url).host).toBe("first.example.com");
  saveProviderConnections([{ id: "first", kind: "s3-compatible", name: "first", created_at: "now", config: { endpoint: "https://changed.example.com", region: "nbg1" } }]);
  expect((await handleStorageAuthorize(request())).status).toBe(409);
});

test("external readers list only named read-only grants and reject legacy tokens", async () => {
  const db = await import("../../shared/db.ts");
  const { createToken } = await import("../lib/auth.ts");
  const { getStorageGrants, saveStorageGrants, storageTokenHash } = await import("../../shared/object-storage.ts");
  const { handleStorageReaders, handleStorageAuthorize } = await import("./storage-access.ts");
  db.insertUser({ id: "reader-admin", username: "reader-admin", password_hash: "unused", is_admin: true });
  const token = await createToken({ userId: "reader-admin", username: "reader-admin" });
  const req = (method: string, body?: unknown) => new Request("https://panel.example/api/admin/storage-readers", {
    method, headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const legacyToken = `ocds_${"b".repeat(64)}`;
  saveStorageGrants([
    { id: "cdn", app: "old-cdn", reader: "skyline-cdn", providerId: "first", endpoint: "https://first.example.com", region: "nbg1", bucket: "media-bucket", prefix: "media/", methods: ["GET", "HEAD"], tokenHash: "same-hash", createdAt: "now" },
    { id: "writer", app: "old-writer", providerId: "first", endpoint: "https://first.example.com", region: "nbg1", bucket: "media-bucket", prefix: "", methods: ["PUT"], tokenHash: "writer-hash", createdAt: "now" },
    { id: "legacy", app: "old-cdn", providerId: "first", endpoint: "https://first.example.com", region: "nbg1", bucket: "media-bucket", prefix: "media/", methods: ["GET", "HEAD"], tokenHash: storageTokenHash(legacyToken), createdAt: "now" },
  ]);
  const legacyRequest = new Request("https://panel.example/api/storage/authorize", { method: "POST", headers: { authorization: `Bearer ${legacyToken}` }, body: JSON.stringify({ method: "GET", key: "image.jpg" }) });
  expect((await handleStorageAuthorize(legacyRequest)).status).toBe(401);
  const listed = await (await handleStorageReaders(req("GET"))).json();
  expect(listed).toEqual([{ id: "cdn", name: "skyline-cdn", connection: "first", bucket: "media-bucket", prefix: "media/", createdAt: "now" }]);
  expect(JSON.stringify(listed)).not.toContain("same-hash");
  expect((await handleStorageReaders(req("DELETE", { id: "cdn" }))).status).toBe(200);
  expect(getStorageGrants().map(g => g.id)).toEqual(["writer", "legacy"]);
});
