import { test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import { createToken } from "../lib/auth.ts";
import { handleAdminNtfy, handleUserNtfy, handleNtfyCredentials, handleNtfyTest, handleCreateNtfyApp } from "./ntfy.ts";
import { NtfySettingsSchema } from "../../shared/ntfy-schema.ts";
import { ntfyPreferences, ntfyCredentials, canReceiveNtfy } from "../../shared/ntfy.ts";
async function actor(id: string, admin = false) {
  db.insertUser({ id, username: id, password_hash: "unused", is_admin: admin });
  return createToken({ userId: id, username: id });
}
const req = (token: string, method = "GET", body?: unknown) => new Request("https://panel.example.com/api/auth/notifications", { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
function enable() {
  const app = db.insertApp({ name: "ntfy", domain: "notify.example.com", image_ref: `docker.io/binwiederhier/ntfy@sha256:${"a".repeat(64)}`, container_port: 80, env_vars: '{"env":{},"outputs":{}}' });
  db.saveSetting("ntfy_settings", JSON.stringify(NtfySettingsSchema.parse({ enabled: true, app_id: app.id, alerts: true, apps: true })));
}
test("administrative configuration requires an administrator", async () => {
  expect((await handleAdminNtfy(req(await actor("user")))).status).toBe(403);
  expect((await handleAdminNtfy(req(await actor("admin", true)))).status).toBe(200);
  expect((await handleUserNtfy(new Request("https://panel.example.com"))).status).toBe(401);
});
test("users configure only their own preferences; normal reads never reveal credentials", async () => {
  enable(); const alice = await actor("alice"), bob = await actor("bob");
  const prefs = { enabled: true, events: ["app"], recovery: true };
  expect((await handleUserNtfy(req(alice, "PUT", prefs))).status).toBe(202);
  expect(ntfyPreferences("bob").enabled).toBe(false);
  expect((await handleNtfyCredentials(req(bob, "POST"))).status).toBe(409);
  const credentials = await (await handleNtfyCredentials(req(alice, "POST"))).json();
  expect(credentials.password).toBeTruthy();
  const normal = await handleUserNtfy(req(alice));
  expect(normal.headers.get("cache-control")).toBe("no-store");
  const text = await normal.text(); expect(text).not.toContain(credentials.password); expect(text).not.toContain(credentials.token);
  expect(ntfyCredentials().filter(c => c.owner_type === "user")).toHaveLength(1);
});
test("invalid preferences are rejected before state changes and test messages are throttled", async () => {
  enable(); const alice = await actor("alice");
  expect((await handleUserNtfy(req(alice, "PUT", { enabled: true, events: ["unknown"], recovery: true }))).status).toBe(400);
  expect(ntfyCredentials()).toHaveLength(0);
  await handleUserNtfy(req(alice, "PUT", { enabled: true, events: ["app"], recovery: true }));
  expect((await handleNtfyTest(req(alice, "POST"))).status).toBe(202);
  expect((await handleNtfyTest(req(alice, "POST"))).status).toBe(429);
});
test("app permission revocation stops future alerts", async () => {
  enable(); await actor("alice");
  db.saveSetting("ntfy_user.alice", JSON.stringify({ enabled: true, events: ["app"], recovery: true }));
  const app = db.insertApp({ name: "test-app", domain: "", image_ref: `ghcr.io/test/app@sha256:${"a".repeat(64)}`, container_port: 3000, env_vars: '{"env":{},"outputs":{}}' });
  expect(canReceiveNtfy("alice", `app:${app.id}`, false)).toBe(false);
  db.setUserPermissions("alice", [{ permission: "apps.view", scopeType: "app", scopeId: String(app.id) }]);
  expect(canReceiveNtfy("alice", `app:${app.id}`, false)).toBe(true);
  db.setUserPermissions("alice", []);
  expect(canReceiveNtfy("alice", `app:${app.id}`, true)).toBe(false);
});

test("admin setup queues app creation and rejects obsolete infrastructure settings", async () => {
  const admin = await actor("admin", true);
  const server = db.insertServer({ name: "host", provider_id: "host", ipv4: "192.0.2.1", ipv6: "", type: "test", location: "test", status: "ready" });
  expect((await handleAdminNtfy(req(admin, "PUT", { enabled: true, domain: "notify.example.com", alerts: true, apps: true }))).status).toBe(400);
  const input = { name: "ntfy", domain: "notify.example.com", server_id: server.id };
  const result = await handleCreateNtfyApp(req(admin, "POST", input));
  expect(result.status).toBe(202);
  expect(db.getApps()).toHaveLength(0);
  const { opId } = await result.json();
  const { getOperation } = await import("../../shared/db/operations.ts");
  expect(getOperation(opId)?.kind).toBe("configure_ntfy");
  expect((await handleCreateNtfyApp(req(admin, "POST", input))).status).toBe(409);
});
