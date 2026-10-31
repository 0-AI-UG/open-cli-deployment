import { createPrivateKey, createSign } from "node:crypto";
import { secretStore } from "../shared/secret-store.ts";

export const CI_GITHUB_SECRET = "ci:github-app";
export type GitHubCiConnection = { app_id: string; installation_id: string; private_key: string; access_token?: string; account_login?: string };
export class GitHubCiError extends Error {
  constructor(public status: number, public path = "", method = "GET") { super(`GitHub CI API ${method} ${path} returned HTTP ${status}`); }
}
export function normalizeCiRepository(input: string): string {
  const value = input.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || value.endsWith("/.") || value.endsWith("/..")) throw new Error("Repository must be github.com owner/repo");
  return value.toLowerCase();
}
export function ciRepositoryFromUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) throw new Error("CI checks require an HTTPS github.com repository");
  return normalizeCiRepository(url.pathname.slice(1));
}
export function githubAppJwt(config: GitHubCiConnection): string {
  if (!/^\d+$/.test(config.app_id) || !/^\d+$/.test(config.installation_id)) throw new Error("GitHub App and installation IDs must be numeric");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: config.app_id })}`;
  const key = createPrivateKey(config.private_key);
  if (key.asymmetricKeyType !== "rsa") throw new Error("GitHub App requires an RSA private key");
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(key).toString("base64url")}`;
}
export async function githubCiRequest<T>(path: string, token: string, method = "GET", body?: unknown): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub API path");
  const response = await fetch(`https://api.github.com${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}), "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Never include response bodies: registration and installation responses contain secrets.
  if (!response.ok) throw new GitHubCiError(response.status, path, method);
  return (response.status === 204 ? undefined : await response.json()) as T;
}
export async function ciInstallationToken(repository: string, config?: GitHubCiConnection, scope: "repository" | "organization" = "repository"): Promise<string> {
  const raw = config ?? JSON.parse(await secretStore.get(CI_GITHUB_SECRET) || "null") as GitHubCiConnection | null;
  if (!raw) throw new Error("Connect a GitHub App with ocd ci connect github first");
  if (raw.access_token) return raw.access_token;
  const repo = scope === "organization" ? normalizeCiOrganization(repository) : normalizeCiRepository(repository);
  const result = await githubCiRequest<{ token: string }>(`/app/installations/${raw.installation_id}/access_tokens`, githubAppJwt(raw), "POST", scope === "repository" ? { repositories: [repo.split("/")[1]] } : {});
  if (!result.token) throw new Error("GitHub did not return an installation token");
  return result.token;
}
export class CiRepositoryError extends Error {}
export async function assertPrivateCiRepository(repository: string, token: string): Promise<void> {
  const repo = await githubCiRequest<{ private: boolean; full_name: string }>(`/repos/${repository}`, token);
  if (!repo.private || repo.full_name.toLowerCase() !== repository) throw new CiRepositoryError("CI runners require an explicitly selected private repository");
}

export function normalizeCiOrganization(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(value)) throw new Error("Invalid GitHub organization name");
  return value;
}
/** Runner-group policy is enforced by GitHub at job assignment, including visibility changes. */
export async function assertCiOrganizationGroup(organization: string, groupId: number, token: string): Promise<{ id: number; name: string; repositories: string[] }> {
  if (!Number.isSafeInteger(groupId) || groupId <= 0) throw new CiRepositoryError("An explicit organization runner group ID is required");
  const group = await githubCiRequest<{ id: number; name: string; visibility: string; allows_public_repositories: boolean }>(`/orgs/${organization}/actions/runner-groups/${groupId}`, token);
  if (group.visibility !== "selected" || group.allows_public_repositories || !group.name) throw new CiRepositoryError("CI runner groups must allow selected private repositories only");
  const repositories: string[] = [];
  for (let page = 1; page <= 100; page++) {
    const selected = await githubCiRequest<{ repositories: { private: boolean; full_name: string }[] }>(`/orgs/${organization}/actions/runner-groups/${groupId}/repositories?per_page=100&page=${page}`, token);
    if (selected.repositories.some(repo => !repo.private || !repo.full_name.toLowerCase().startsWith(`${organization}/`))) throw new CiRepositoryError("CI runner group includes a public or foreign repository");
    repositories.push(...selected.repositories.map(repo => repo.full_name.toLowerCase()));
    if (selected.repositories.length < 100) {
      if (!repositories.length) throw new CiRepositoryError("CI runner group must select at least one private repository");
      return { id: group.id, name: group.name, repositories };
    }
  }
  throw new CiRepositoryError("Too many repositories to validate the CI runner group");
}

/** Poll only permitted repositories, including queued jobs in partially running workflows. */
export async function hasQueuedCiJob(repositories: string[], token: string): Promise<boolean> {
  for (const repository of repositories) {
    for (const status of ["queued", "in_progress"]) {
      for (let runPage = 1; runPage <= 100; runPage++) {
        let runs: { workflow_runs: { id: number }[] };
        try {
          runs = await githubCiRequest(`/repos/${repository}/actions/runs?status=${status}&per_page=100&page=${runPage}`, token);
        } catch (error) {
          // Some selected repositories (e.g. temporary security forks) have no Actions API.
          // Their absence must not starve work in the rest of the organization.
          if (error instanceof GitHubCiError && error.status === 404) break;
          throw error;
        }
        for (const run of runs.workflow_runs) {
          for (let page = 1; page <= 100; page++) {
            let result: { jobs: { status: string; labels: string[] }[] };
            try {
              result = await githubCiRequest(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`, token);
            } catch (error) {
              // Runs can be deleted between discovery and job inspection.
              if (error instanceof GitHubCiError && error.status === 404) break;
              throw error;
            }
            if (result.jobs.some(job => job.status === "queued" && job.labels.some(label => label.toLowerCase() === "ocd-ci"))) return true;
            if (result.jobs.length < 100) break;
          }
        }
        if (runs.workflow_runs.length < 100) break;
      }
    }
  }
  return false;
}
