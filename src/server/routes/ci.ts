import * as db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { normalizeBuildWorkerName } from "../../engine/build-worker.ts";
import { assertCiServerAvailable } from "../../engine/ci-runner.ts";
import { CI_GITHUB_SECRET, CiRepositoryError, GitHubCiError, assertPrivateCiRepository, ciInstallationToken, githubAppJwt, githubCiRequest, normalizeCiRepository, normalizeCiOrganization, assertCiOrganizationGroup, ciRepositoryFromUrl, type GitHubCiConnection } from "../../engine/ci-github.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { corsHeaders } from "../lib/cors.ts";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: corsHeaders });
const bad = (error: string, status = 400) => json({ error }, status);
function ciError(error: unknown): Response {
  if (error instanceof CiRepositoryError) return bad(error.message);
  if (error instanceof GitHubCiError) return bad(`${error.message}. Check the App installation, repository access, and permissions.`, 502);
  return handleError(error);
}

export async function handleCiConnection(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    if (request.method === "GET") {
      const raw = await secretStore.get(CI_GITHUB_SECRET);
      const config = raw ? JSON.parse(raw) as GitHubCiConnection : null;
      return json({ connected: !!config, app_id: config?.app_id, installation_id: config?.installation_id, auth_type: config?.access_token ? "token" : "app", account_login: config?.account_login });
    }
    const body = await request.json() as GitHubCiConnection;
    if (body.access_token !== undefined) {
      if (typeof body.access_token !== "string" || !/^[A-Za-z0-9_]{20,256}$/.test(body.access_token)) return bad("Invalid GitHub access token");
      const account = await githubCiRequest<{ login: string }>("/user", body.access_token);
      const previous = await secretStore.get(CI_GITHUB_SECRET);
      if (previous) {
        const old = JSON.parse(previous) as GitHubCiConnection;
        if ((!old.access_token || old.account_login !== account.login) && db.getCiRunners().some(row => row.status !== "drained")) return bad("Drain all CI runners before switching GitHub identities", 409);
      }
      await secretStore.set(CI_GITHUB_SECRET, JSON.stringify({ app_id: "", installation_id: "", private_key: "", access_token: body.access_token, account_login: account.login }));
      return json({ connected: true, auth_type: "token", account_login: account.login });
    }
    const config = { app_id: String(body.app_id ?? ""), installation_id: String(body.installation_id ?? ""), private_key: String(body.private_key ?? "") };
    if (config.private_key.length > 20_000) return bad("Invalid private key");
    let jwt: string;
    try { jwt = githubAppJwt(config); } catch { return bad("Valid numeric App/installation IDs and an RSA PEM private key are required"); }
    // Validate installation ownership before persisting a connection.
    await githubCiRequest(`/app/installations/${config.installation_id}`, jwt);
    const previous = await secretStore.get(CI_GITHUB_SECRET);
    if (previous) {
      const old = JSON.parse(previous) as GitHubCiConnection;
      if ((old.app_id !== config.app_id || old.installation_id !== config.installation_id) && db.getCiRunners().some(runner => runner.status !== "drained")) {
        return bad("Drain all CI runners before switching GitHub App installations", 409);
      }
    }
    await secretStore.set(CI_GITHUB_SECRET, JSON.stringify(config));
    return json({ connected: true, app_id: config.app_id, installation_id: config.installation_id });
  } catch (error) { return ciError(error); }
}
export async function handleCiRunners(request: Request): Promise<Response> {
  let inserted = 0;
  try {
    const actor = await requireAuthenticated(request);
    if (request.method === "GET") return json(db.getCiRunners().map(row => ({ ...row, server: (() => {
      const s = db.getServer(row.server_id); return s ? { id: s.id, name: s.name } : null;
    })(), actions_url: row.scope === "organization" ? `https://github.com/organizations/${row.repository}/settings/actions/runners` : `https://github.com/${row.repository}/actions` })));
    const body = await request.json() as { server_id: number; name?: string; repository?: string; organization?: string; runner_group_id?: number; shared_builds?: boolean; job_timeout_seconds?: number };
    if (body.shared_builds !== undefined && typeof body.shared_builds !== "boolean") return bad("shared_builds must be a boolean");
    const sharedBuilds = body.shared_builds === true;
    const jobTimeout = body.job_timeout_seconds ?? 1800;
    if (!Number.isInteger(jobTimeout) || jobTimeout < 60 || jobTimeout > 21600) return bad("Job timeout must be between 60 and 21600 seconds");
    const serverId = Number(body.server_id);
    if (!Number.isSafeInteger(serverId)) return bad("Invalid server ID");
    try { assertCiServerAvailable(serverId, sharedBuilds); } catch (error) { return bad((error as Error).message, 409); }
    if (db.getCiRunnerByServerId(serverId)) return bad("Server already reserved for CI", 409);
    if (!!body.repository === !!body.organization) return bad("Select exactly one repository or organization");
    let repository: string;
    try { repository = body.organization ? normalizeCiOrganization(body.organization) : normalizeCiRepository(String(body.repository ?? "")); } catch (error) { return bad((error as Error).message); }
    const name = normalizeBuildWorkerName(String(body.name ?? `ocd-ci-${serverId}`));
    if (!name) return bad("Invalid CI runner name");
    if (db.getCiRunners().some(row => row.name === name)) return bad("CI runner name already in use", 409);
    const token = await ciInstallationToken(repository, undefined, body.organization ? "organization" : "repository");
    const group = body.organization ? await assertCiOrganizationGroup(repository, Number(body.runner_group_id), token) : undefined;
    if (!group) await assertPrivateCiRepository(repository, token);
    // Recheck after network I/O: another request may have reserved this host.
    assertCiServerAvailable(serverId, sharedBuilds);
    if (db.getCiRunnerByServerId(serverId)) return bad("Server already reserved for CI", 409);
    const runner = db.insertCiRunner(serverId, name, repository, group, sharedBuilds, jobTimeout);
    inserted = runner.id;
    const result = enqueue({ kind: "install_ci_runner", resourceKeys: [`ci-runner:${runner.id}`, `server:${serverId}`], input: { runnerId: runner.id }, trigger: actor.client === "cli" ? "cli" : "ui", triggeredBy: actor.userId });
    inserted = 0;
    return json({ op_id: result.opId, runner }, 202);
  } catch (error) { if (inserted) db.deleteCiRunner(inserted); return ciError(error); }
}
export async function handleCiRunnerAction(request: Request, id: number): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const runner = db.getCiRunner(id);
    if (!runner) return bad("CI runner not found", 404);
    let kind = "sync_ci_runner";
    if (request.method === "DELETE") {
      db.updateCiRunner(id, { draining: 1 });
      kind = "remove_ci_runner";
    } else {
      const body = await request.json() as { action: string };
      if (!["drain", "resume", "retry"].includes(body.action)) return bad("Expected drain, resume, or retry");
      if (body.action !== "retry") db.updateCiRunner(id, { draining: body.action === "drain" ? 1 : 0, status: body.action === "drain" ? "draining" : "starting" });
      if (!runner.runner_version && body.action === "retry") kind = "install_ci_runner";
    }
    const { opId } = enqueue({ kind, resourceKeys: [`ci-runner:${id}`, `server:${runner.server_id}`], input: { runnerId: id }, trigger: actor.client === "cli" ? "cli" : "ui", triggeredBy: actor.userId });
    return json({ op_id: opId }, 202);
  } catch (error) { return ciError(error); }
}
export async function handleCiCheckPolicy(request: Request, id: number): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const source = db.getBuildSource(id);
    if (!source) return bad("Build source not found", 404);
    if (request.method === "GET") return json(db.getCiCheckPolicy(id) ?? { checks: [], timeout_seconds: 3600 });
    const body = await request.json() as db.CiCheckPolicy;
    if (!Array.isArray(body.checks) || body.checks.length > 50 || body.checks.some(check => !check || typeof check.name !== "string" || !check.name.trim() || check.name.length > 255 || !Number.isSafeInteger(check.app_id) || check.app_id <= 0)) return bad("Checks require a name and positive GitHub App ID");
    const timeout = body.timeout_seconds ?? 3600;
    if (!Number.isInteger(timeout) || timeout < 60 || timeout > 86400) return bad("Timeout must be between 60 and 86400 seconds");
    try { ciRepositoryFromUrl(source.repository); } catch (error) { return bad((error as Error).message); }
    db.setCiCheckPolicy(id, { checks: body.checks, timeout_seconds: timeout });
    return json(db.getCiCheckPolicy(id));
  } catch (error) { return ciError(error); }
}
