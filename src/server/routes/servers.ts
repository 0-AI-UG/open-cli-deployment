import { corsHeaders } from "../lib/cors.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { getServersWithApps } from "../../engine/deploy/index.ts";
import { enrichAppForResponse } from "./apps.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";

/** Scrub each server's app rows through enrichAppForResponse so secrets never
 *  leak from the server-overview endpoints (same guarantee as /api/apps). */
function scrubServersWithApps(servers: any[]): any[] {
  return servers.map((s) => ({ ...s, apps: (s.apps || []).map((a: any) => enrichAppForResponse(a)) }));
}

export async function handleGetServers(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const result = scrubServersWithApps(getServersWithApps());
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteServer(request: Request, serverId: number): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    if (!db.getServer(serverId)) {
      return Response.json({ error: "Server not found" }, { status: 404, headers: corsHeaders });
    }
    if (db.getBuildWorkerByServerId(serverId)) {
      return Response.json(
        { error: "Remove the OCD build worker before deleting its server" },
        { status: 409, headers: corsHeaders },
      );
    }
    await enforceConfirmation(request, payload, "delete_server", "server", String(serverId));
    const apps = db.getApps(serverId);
    const keys = [
      `server:${serverId}`,
      ...apps.map((a) => `app:${a.id}`),
    ];
    const { opId } = enqueue({
      kind: "destroy_server",
      resourceKeys: keys,
      input: { serverId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ ok: true, op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRefreshServers(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const result = scrubServersWithApps(getServersWithApps());
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
