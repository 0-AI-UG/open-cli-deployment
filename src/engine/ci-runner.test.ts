import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();
import { expect, mock, test } from "bun:test";
let commands: string[] = [];
let privateInputs: string[] = [];
let githubCalls: string[] = [];
let busy = false;
let service = "active";
let failDelete = false;
let queued = true;
let failRestore = false;
const remote = async (_ip: string, command: string) => { commands.push(command); return { stdout: command.includes("ActiveState") ? service : "", stderr: "", exitCode: failRestore && command.includes("--bootstrap") ? 1 : 0 }; };
mock.module("../shared/remote/index.ts", () => ({ sshExec: remote, sshExecWithStdin: async (ip: string, command: string, input: string) => { privateInputs.push(input); return remote(ip, command); } }));
mock.module("./ci-github.ts", () => ({
  ciInstallationToken: async () => "installation-token",
  assertPrivateCiRepository: async () => {},
  hasQueuedCiJob: async () => queued,
  assertCiOrganizationGroup: async (_org: string, id: number) => ({ id, name: "OCD CI", repositories: ["acme/api"] }),
  GitHubCiError: class extends Error {},
  CiRepositoryError: class extends Error {},
  githubCiRequest: async (path: string, _token: string, method = "GET") => {
    githubCalls.push(`${method} ${path}`);
    if (method === "DELETE" && failDelete) throw new Error("busy race");
    if (path.endsWith("/releases/latest")) return { tag_name: "v2.333.0", assets: [{ name: "actions-runner-linux-x64-2.333.0.tar.gz", browser_download_url: "https://github.com/actions/runner/releases/download/v2.333.0/actions-runner-linux-x64-2.333.0.tar.gz", digest: `sha256:${"a".repeat(64)}` }] };
    if (path.endsWith("/registration-token")) return { token: "private-registration-token" };
    if (path.includes("?name=")) return { runners: [] };
    return { id: 9, busy, status: "online" };
  },
}));
import * as db from "../shared/db.ts";
import { ciPackageScript, syncCiRunner, assertCiServerAvailable } from "./ci-runner.ts";
function runner() {
  commands = []; privateInputs = []; githubCalls = []; busy = false; service = "active"; failDelete = false; queued = true; failRestore = false;
  const suffix = randomSuffix();
  const host = db.insertServer({ name: suffix, provider_id: suffix, ipv4: "203.0.113.60", ipv6: "", type: "cx23", location: "nbg1", status: "ready" });
  const row = db.insertCiRunner(host.id, `ci-${suffix}`, "acme/api");
  db.updateCiRunner(row.id, { github_runner_id: 9, status: "online" });
  return row;
}
test("busy runners remain running during drain", async () => {
  const row = runner(); busy = true;
  db.updateCiRunner(row.id, { draining: 1 });
  await syncCiRunner(row.id);
  expect(db.getCiRunner(row.id)?.status).toBe("draining");
  expect(commands.some(command => command.includes("systemctl stop"))).toBe(false);
  expect(githubCalls.some(call => call.startsWith("DELETE"))).toBe(false);
});
test("drain deregisters before stopping, and never stops if GitHub assigns a job during the check", async () => {
  const row = runner(); db.updateCiRunner(row.id, { draining: 1 }); failDelete = true;
  await expect(syncCiRunner(row.id)).rejects.toThrow("busy race");
  expect(commands.some(command => command.includes("systemctl stop"))).toBe(false);
  failDelete = false;
  await syncCiRunner(row.id);
  expect(db.getCiRunner(row.id)?.status).toBe("drained");
  expect(commands.some(command => command.includes("systemctl stop"))).toBe(true);
});
test("healthy active runner is adopted without registering another runner", async () => {
  const row = runner(); await syncCiRunner(row.id);
  expect(db.getCiRunner(row.id)?.status).toBe("online");
  expect(githubCalls.filter(call => call.startsWith("POST"))).toEqual([]);
  expect(commands).toHaveLength(1);
});
test("build workers cannot be repurposed as CI hosts", () => {
  const row = runner(); db.deleteCiRunner(row.id);
  db.insertBuildWorker({ serverId: row.server_id, name: `builder-${randomSuffix()}` });
  expect(() => assertCiServerAvailable(row.server_id)).toThrow("--share-builds");
});
test("runner packages require official URLs and verified SHA256", () => {
  const release = { tag_name: "v2.333.0", assets: [{ name: "actions-runner-linux-x64-2.333.0.tar.gz", browser_download_url: "https://github.com/actions/runner/releases/download/v2.333.0/actions-runner-linux-x64-2.333.0.tar.gz", digest: `sha256:${"a".repeat(64)}` }] };
  expect(ciPackageScript(release).script).toContain("sha256sum -c");
  release.assets[0]!.browser_download_url = "https://evil.test/runner.tar.gz";
  expect(() => ciPackageScript(release)).toThrow("verified Linux x64 asset");
});

test("an exited single-job runner is replaced with a verified package and an opaque registration token", async () => {
  const row = runner(); service = "inactive";
  await syncCiRunner(row.id);
  expect(githubCalls.some(call => call.startsWith("DELETE"))).toBe(true);
  expect(db.getCiRunner(row.id)?.runner_version).toBe("2.333.0");
  expect(db.getCiRunner(row.id)?.status).toBe("starting");
  expect(privateInputs).toEqual(["private-registration-token\n"]);
  expect(commands.some(command => command.includes("--ephemeral"))).toBe(true);
  expect(commands.join("\n")).not.toContain("private-registration-token");
});

test("organization runners register into the selected private repository group", async () => {
  const old = runner(); db.deleteCiRunner(old.id);
  const row = db.insertCiRunner(old.server_id, `org-${randomSuffix()}`, "acme", { id: 77, name: "OCD CI" });
  service = "inactive";
  await syncCiRunner(row.id);
  expect(githubCalls.some(call => call.includes("/orgs/acme/actions/runners/registration-token"))).toBe(true);
  expect(commands.some(command => command.includes("--runnergroup 'OCD CI'"))).toBe(true);
  expect(commands.some(command => command.includes("--url 'https://github.com/acme'"))).toBe(true);
});

function sharedRunner() {
  const old = runner(); db.deleteCiRunner(old.id);
  const worker = db.insertBuildWorker({ serverId: old.server_id, name: `build-${randomSuffix()}` });
  db.updateBuildWorker(worker.id, { status: "online", architecture: "x86_64", disk_free_bytes: 30 * 1024 ** 3, last_checked_at: new Date().toISOString() });
  const ci = db.insertCiRunner(old.server_id, `ci-${randomSuffix()}`, "acme/api", undefined, true);
  db.updateCiRunner(ci.id, { github_runner_id: 9, status: "idle" });
  return { ci, worker };
}
test("shared mode is explicit and idle CI does not reserve build capacity", async () => {
  const { ci } = sharedRunner(); service = "inactive"; queued = false;
  expect(() => assertCiServerAvailable(ci.server_id, true)).not.toThrow();
  await syncCiRunner(ci.id);
  expect(db.getCiRunner(ci.id)?.host_reserved).toBe(0);
  expect(db.getCiRunner(ci.id)?.status).toBe("idle");
  expect(githubCalls.some(call => call.startsWith("POST"))).toBe(false);
});
test("shared CI waits for a leased build and starts only after acquiring its own host reservation", async () => {
  const { ci, worker } = sharedRunner(); service = "inactive";
  const { enqueueOperation } = require("../shared/db/operations.ts");
  const operation = enqueueOperation({ kind: "test_build", resourceKeys: [], input: {}, trigger: "test" });
  const lease = db.tryAcquireBuildWorkerLease({ operationId: operation.id, candidateWorkerIds: [worker.id] })!;
  await syncCiRunner(ci.id);
  expect(db.getCiRunner(ci.id)?.status).toBe("waiting_for_build");
  expect(commands.some(command => command.includes("buildx stop"))).toBe(false);
  db.releaseBuildWorkerLease({ operationId: operation.id, leaseToken: lease.lease_token });
  await syncCiRunner(ci.id);
  expect(db.getCiRunner(ci.id)?.host_reserved).toBe(1);
  expect(commands.some(command => command.includes("flock -n -E 75") && command.includes("buildx stop"))).toBe(true);
});
test("restart recovery cleans up an exited CI job and restores BuildKit before releasing its reservation", async () => {
  const { ci } = sharedRunner(); service = "inactive";
  db.updateCiRunner(ci.id, { host_reserved: 1 });
  failRestore = true;
  await expect(syncCiRunner(ci.id)).rejects.toThrow("remains reserved");
  expect(db.getCiRunner(ci.id)?.host_reserved).toBe(1);
  failRestore = false;
  await syncCiRunner(ci.id);
  expect(db.getCiRunner(ci.id)?.host_reserved).toBe(0);
  expect(commands.some(command => command.includes("buildx inspect ocd-worker --bootstrap"))).toBe(true);
});
test("a shared idle listener yields without interrupting a job assigned during deregistration", async () => {
  const { ci } = sharedRunner(); service = "active";
  db.updateCiRunner(ci.id, { host_reserved: 1, registered_at: new Date(Date.now() - 90_000).toISOString() });
  failDelete = true;
  await expect(syncCiRunner(ci.id)).rejects.toThrow("busy race");
  expect(db.getCiRunner(ci.id)?.host_reserved).toBe(1);
  expect(commands.some(command => command.includes("systemctl stop"))).toBe(false);
  failDelete = false;
  await syncCiRunner(ci.id);
  expect(db.getCiRunner(ci.id)?.host_reserved).toBe(0);
  expect(db.getCiRunner(ci.id)?.status).toBe("idle");
});
