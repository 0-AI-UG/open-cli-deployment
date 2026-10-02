import type { Server } from "../../shared/rpc.ts";
import * as db from "../../shared/db.ts";

type DbApp = {
  id: number;
  name: string;
  domain: string;
  container_port: number;
  env_vars: string;
  status: string;
  deployed_by: string | null;
};

type DbReplica = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
};

/**
 * Aggregated view used by the dashboard and /api/servers. Per-server listing
 * of apps, enriched with host_port + the username of whoever originally
 * deployed each app, plus whether the server is a dedicated build worker.
 */
export function getServersWithApps(): any[] {
  const servers = db.getServers() as Server[];
  return servers.map((s) => {
    const apps = db.getApps(s.id) as DbApp[];
    return {
      ...s,
      build_worker: !!db.getBuildWorkerByServerId(s.id),
      apps: apps.map((a) => {
        const reps = db.getReplicas(a.id) as DbReplica[];
        const first = reps[0];
        const serverIds = Array.from(new Set(reps.map((r) => r.server_id)));
        const deployedByUser = a.deployed_by ? db.getUserById(a.deployed_by) : null;
        return {
          ...a,
          host_port: first?.host_port ?? 0,
          servers: serverIds,
          deployed_by_username: deployedByUser?.username || null,
        };
      }),
    };
  });
}
