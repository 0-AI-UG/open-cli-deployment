import { appStorageMounts, measureStorage } from "../lib/storage-inventory.ts";
import { corsHeaders } from "../lib/cors.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { inspectServerGc } from "../../shared/remote/index.ts";

export async function handleGetAppStorage(request: Request, appId: number): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    const current = db.getDeployments(appId).find((deployment) => deployment.status === "deployed") ?? null;
    const servers = [...new Set(db.getReplicas(appId).map((replica) => replica.server_id))]
      .map((id) => db.getServer(id))
      .filter((server): server is NonNullable<typeof server> => !!server?.ipv4);
    const inventories = await Promise.all(servers.map(async (server) => ({
      server_id: server.id,
      server_name: server.name,
      inventory: await inspectServerGc(server.ipv4, server.ssh_host_key || undefined, {
        activeAppNames: [...new Set(db.getApps(server.id).map((candidate) => candidate.name))],
      }),
    })));
    const reclaimable = inventories.flatMap(({ server_id, server_name, inventory }) =>
      inventory.images
        .filter((image) => image.category.startsWith("reclaimable-") && image.refs.some((ref) => ref.startsWith(`${app.name}:`)))
        .map((image) => ({ server_id, server_name, ...image }))
    );
    return Response.json({
      mounts: await measureStorage(appStorageMounts(app)),
      current: current ? {
        deployment_id: current.id,
        image_size_bytes: current.image_size_bytes,
        archive_size_bytes: current.archive_size_bytes,
        transfer_size_bytes: current.transfer_size_bytes,
      } : null,
      reclaimable,
      reclaimable_image_bytes_upper_bound: reclaimable.reduce((sum, image) => sum + image.size_bytes, 0),
      caveat: "Docker image sizes include shared layers; reclaimable image bytes are an upper bound, not additive freed space.",
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
