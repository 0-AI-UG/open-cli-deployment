import { get } from "./api.ts";

export type DeployReadiness = {
  ready: boolean;
  hetzner: { status: string; configured: boolean };
  worker: { status: string; online: number; total: number };
  registry: { status: string; configured: boolean; scope: string; username: string; covers_target: boolean | null };
  source: { status: string; configured: boolean; host: string; covers_repository: boolean | null };
  actions: Array<{ command: string; label: string }>;
};

export async function getDeployReadiness(repository?: string, image?: string): Promise<DeployReadiness> {
  const query = new URLSearchParams();
  if (repository) query.set("repository", repository);
  if (image) query.set("image", image);
  return get<DeployReadiness>(`/api/readiness${query.size ? `?${query}` : ""}`);
}

/** Check build prerequisites immediately before a manifest build. Build
 * capacity is never picked automatically: a missing worker is an error that
 * names the explicit `ocd runners install` command. */
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

  throw new Error(
    "No build worker is online. Install one on a dedicated server with " +
    "`ocd runners install --server=<name>` (create the server first with " +
    "`ocd servers create --type=<type> --location=<location>` if needed).",
  );
}
