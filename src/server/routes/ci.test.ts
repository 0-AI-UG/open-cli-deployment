import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();
import { expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
mock.module("../lib/permissions.ts", () => ({ requireAuthenticated: async () => ({ userId: "test-user", client: "cli" }) }));
import * as db from "../../shared/db.ts";
import { getOperation } from "../../shared/db/operations.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { CI_GITHUB_SECRET } from "../../engine/ci-github.ts";
import { handleCiConnection, handleCiRunners, handleCiRunnerAction, handleCiCheckPolicy } from "./ci.ts";
import { handleInstallBuildWorker } from "./build-workers.ts";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = { app_id: "123", installation_id: "456", private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
function request(method: string, body?: unknown): Request { return new Request("http://localhost/api/ci/runners", { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }); }
function host() { const name = randomSuffix(); return db.insertServer({ name, provider_id: name, ipv4: "203.0.113.70", ipv6: "", type: "cx23", location: "nbg1", status: "ready" }); }
async function github<T>(callback: () => Promise<T>, privateRepo = true): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith("/user")) return Response.json({ login: "test-account" });
    if (path.includes("/runner-groups/77/repositories?")) return Response.json({ repositories: [{ full_name: "acme/api", private: true }] });
    if (path.endsWith("/runner-groups/77")) return Response.json({ id: 77, name: "OCD CI", visibility: "selected", allows_public_repositories: false });
    if (path.endsWith("access_tokens")) return Response.json({ token: "installation-secret" });
    if (path.endsWith("/repos/acme/api")) return Response.json({ full_name: "acme/api", private: privateRepo });
    return Response.json({ id: 456 });
  }) as unknown as typeof fetch;
  await secretStore.set(CI_GITHUB_SECRET, JSON.stringify(config));
  try { return await callback(); } finally { globalThis.fetch = original; }
}
test("connection validates GitHub and stores PEM only in encrypted secrets", async () => github(async () => {
  expect((await handleCiConnection(request("PUT", config))).status).toBe(200);
  const response = await handleCiConnection(request("GET"));
  const text = await response.text();
  expect(text).toContain('"connected":true'); expect(text).not.toContain("PRIVATE KEY");
  expect(await secretStore.get(CI_GITHUB_SECRET)).toContain(config.private_key.slice(0, 30));
}));
test("dedicated installation reserves server before execution without putting secrets in the operation", async () => github(async () => {
  await secretStore.set(CI_GITHUB_SECRET, JSON.stringify(config));
  const server = host();
  const response = await handleCiRunners(request("POST", { server_id: server.id, repository: "acme/api" }));
  expect(response.status).toBe(202);
  const result = await response.json() as { op_id: number };
  const operation = getOperation(result.op_id)!;
  expect(operation.kind).toBe("install_ci_runner");
  expect(operation.input_json).not.toContain("secret");
  expect(operation.input_json).not.toContain("PRIVATE KEY");
  expect(db.getCiRunnerByServerId(server.id)).not.toBeNull();
  expect((await handleInstallBuildWorker(request("POST", { server_id: server.id }))).status).toBe(409);
  expect((await handleCiRunners(request("POST", { server_id: server.id, repository: "acme/api" }))).status).toBe(409);
}));
test("public repositories cannot reserve a CI server", async () => github(async () => {
  const server = host();
  expect((await handleCiRunners(request("POST", { server_id: server.id, repository: "acme/api" }))).status).toBe(400);
  expect(db.getCiRunnerByServerId(server.id)).toBeNull();
}, false));
test("drain is durable and queues serialized reconciliation", async () => {
  const server = host();
  const runner = db.insertCiRunner(server.id, `ci-${randomSuffix()}`, "acme/api");
  db.updateCiRunner(runner.id, { status: "busy" });
  const response = await handleCiRunnerAction(request("POST", { action: "drain" }), runner.id);
  expect(response.status).toBe(202);
  expect(db.getCiRunner(runner.id)?.draining).toBe(1);
  const operation = getOperation((await response.json() as any).op_id)!;
  expect(JSON.parse(operation.resource_keys)).toContain(`server:${server.id}`);
});
test("policies require provider IDs, valid timeouts, and a GitHub source", async () => {
  const server = host(); const worker = db.insertBuildWorker({ serverId: server.id, name: `builder-${randomSuffix()}` });
  const source = db.upsertBuildSource({ repository: `https://github.com/acme/${randomSuffix()}.git`, branch: "main", workerId: worker.id });
  expect((await handleCiCheckPolicy(request("PUT", { checks: [{ name: "test" }] }), source.id)).status).toBe(400);
  expect((await handleCiCheckPolicy(request("PUT", { checks: [{ name: "test", app_id: 123 }], timeout_seconds: 0 }), source.id)).status).toBe(400);
  const policy = { checks: [{ name: "test", app_id: 123 }], timeout_seconds: 120 };
  expect((await handleCiCheckPolicy(request("PUT", policy), source.id)).status).toBe(200);
  expect(db.getCiCheckPolicy(source.id)).toEqual(policy);
});

test("token connections are encrypted and never returned by connection status", async () => github(async () => {
  const access_token = "gho_" + "x".repeat(36);
  expect((await handleCiConnection(request("PUT", { access_token }))).status).toBe(200);
  const status = await handleCiConnection(request("GET"));
  const body = await status.text();
  expect(body).toContain("test-account"); expect(body).not.toContain(access_token);
  expect(await secretStore.get(CI_GITHUB_SECRET)).toContain(access_token);
}));
test("organization installation requires an explicit selected-private runner group", async () => github(async () => {
  const server = host();
  const response = await handleCiRunners(request("POST", { server_id: server.id, organization: "acme", runner_group_id: 77 }));
  expect(response.status).toBe(202);
  const runner = db.getCiRunnerByServerId(server.id)!;
  expect(runner.scope).toBe("organization"); expect(runner.runner_group_id).toBe(77);
  const other = host();
  expect((await handleCiRunners(request("POST", { server_id: other.id, organization: "acme" }))).status).toBe(400);
  expect(db.getCiRunnerByServerId(other.id)).toBeNull();
}));
