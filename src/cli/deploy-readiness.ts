import { get, post } from "./api.ts";
import { followOp } from "./ops.ts";
import { promptLine } from "./prompt.ts";
import { BOLD, DIM, RESET, YELLOW } from "./format.ts";

export type DeployReadiness = {
  ready: boolean;
  hetzner: { status: string; configured: boolean };
  worker: { status: string; online: number; total: number; candidate_server: { id: number; name: string } | null };
  registry: { status: string; configured: boolean; scope: string; username: string; covers_target: boolean | null };
  source: { status: string; configured: boolean; host: string; covers_repository: boolean | null };
  actions: Array<{ command: string; label: string }>;
};

type Server = { id: number; name: string };

export async function getDeployReadiness(repository?: string, image?: string): Promise<DeployReadiness> {
  const query = new URLSearchParams();
  if (repository) query.set("repository", repository);
  if (image) query.set("image", image);
  return get<DeployReadiness>(`/api/readiness${query.size ? `?${query}` : ""}`);
}

async function installWorker(server: Server): Promise<void> {
  console.log(`${DIM}Installing the dedicated OCD BuildKit worker on ${server.name}…${RESET}`);
  const installed = await post<{ op_id: number }>("/api/runners", { server_id: server.id });
  const result = await followOp(installed.op_id);
  if (!result.ok) throw new Error(result.error || "Build-worker installation failed");
}

/** Make build capacity available immediately before a manifest build. This is
 * deliberately CLI orchestration: the backend still performs every mutation
 * through the same durable operations and browser confirmation paths. */
export async function ensureBuildReadiness(repository = "", image = ""): Promise<void> {
  const readiness = await getDeployReadiness(repository, image);
  if (!readiness.registry.configured) {
    throw new Error(`A registry connection is required to publish ${image}. Run: ocd registry login`);
  }
  if (image && readiness.registry.covers_target === false) {
    throw new Error(
      `Image ${image} is outside the connected registry scope ${readiness.registry.scope || "(none)"}. ` +
      `Run: ocd registry login ${image.split("/").slice(0, -1).join("/")}`,
    );
  }
  if (repository && readiness.source.covers_repository === false && readiness.source.configured) {
    throw new Error(
      `Repository host is outside the connected source host ${readiness.source.host}. Run: ocd source login`,
    );
  }
  if (readiness.worker.online > 0) return;

  if (readiness.worker.candidate_server) {
    const candidate = readiness.worker.candidate_server;
    const answer = await promptLine(
      `${YELLOW}No build worker is online.${RESET} Reserve empty server ${BOLD}${candidate.name}${RESET} as a dedicated worker? [Y/n] `,
    );
    if (answer && !/^y(es)?$/i.test(answer)) {
      throw new Error(`A build worker is required. Run: ocd runners install --server=${candidate.id}`);
    }
    await installWorker(candidate);
    return;
  }

  throw new Error(
    "No build worker is online and no empty server is available. Create a dedicated server with " +
    "`ocd servers create --type=<type> --location=<location>`, then run `ocd runners install --server=<id>`.",
  );
}
