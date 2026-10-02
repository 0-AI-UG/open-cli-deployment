import * as db from "../shared/db.ts";
import { getHetznerToken, secretStore } from "../shared/secret-store.ts";
import { probeBuildWorker } from "./build-worker.ts";
import { imageMatchesRegistryScope } from "./registry-config.ts";
import { repositoryHost } from "./source-config.ts";

export type ReadinessStatus = "ready" | "warning" | "blocked";
export type DeployReadiness = {
  ready: boolean;
  hetzner: { status: ReadinessStatus; configured: boolean };
  worker: {
    status: ReadinessStatus;
    online: number;
    total: number;
  };
  registry: {
    status: ReadinessStatus;
    configured: boolean;
    scope: string;
    username: string;
    covers_target: boolean | null;
  };
  source: {
    status: ReadinessStatus;
    configured: boolean;
    host: string;
    covers_repository: boolean | null;
  };
  actions: Array<{ command: string; label: string }>;
};

export async function inspectDeployReadiness(input: {
  repository?: string;
  image?: string;
} = {}): Promise<DeployReadiness> {
  const buildDelivery = !!input.repository;
  const settings = db.getSettings();
  const hetznerConfigured = !!await getHetznerToken().catch(() => "");
  const workers = buildDelivery ? db.getBuildWorkers() : [];
  let online = 0;
  for (const worker of workers) {
    const server = db.getServer(worker.server_id);
    if (!server || server.status !== "ready") continue;
    const observed = await probeBuildWorker(server).catch(() => ({ online: false }));
    if (observed.online) online++;
  }
  const scope = settings.oci_artifact_ref || "";
  const registryPassword = await secretStore.get("oci_registry_password");
  const registryConfigured = !!(scope && settings.oci_registry_username && registryPassword);
  const coversTarget = input.image ? imageMatchesRegistryScope(input.image, scope) : null;
  const sourceHost = (settings.github_build_host || "github.com").toLowerCase();
  const sourceToken = await secretStore.get("github_build_token");
  const sourceConfigured = !!sourceToken;
  const coversRepository = input.repository
    ? repositoryHost(input.repository) === sourceHost
    : null;
  const actions: DeployReadiness["actions"] = [];
  if (buildDelivery && !online) actions.push({
    command: "ocd runners install --server=<name>",
    label: "Install a build worker on a dedicated server (create one with `ocd servers create` if needed)",
  });
  if (buildDelivery && (!registryConfigured || coversTarget === false)) {
    actions.push({ command: "ocd registry login", label: "Connect the build output registry" });
  }
  if (coversRepository === false && sourceConfigured) actions.push({ command: "ocd source login", label: "Reconnect private source access for this repository host" });

  return {
    ready: !buildDelivery || (online > 0 && registryConfigured && coversTarget !== false),
    hetzner: { status: hetznerConfigured ? "ready" : "warning", configured: hetznerConfigured },
    worker: {
      status: !buildDelivery ? "ready" : online ? "ready" : "blocked",
      online,
      total: workers.length,
    },
    registry: {
      status: buildDelivery && coversTarget === false
        ? "blocked"
        : registryConfigured ? "ready" : buildDelivery ? "blocked" : "warning",
      configured: registryConfigured,
      scope,
      username: settings.oci_registry_username || "",
      covers_target: coversTarget,
    },
    source: {
      status: !buildDelivery ? "ready" : coversRepository === false ? "warning" : sourceConfigured ? "ready" : "warning",
      configured: sourceConfigured,
      host: sourceHost,
      covers_repository: coversRepository,
    },
    actions,
  };
}
