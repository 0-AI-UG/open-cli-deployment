import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, appScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { parsePlacement, resolvePlacement } from "../../shared/placement.ts";

export async function handleGetReplicas(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
    const replicas = db.getReplicas(appId);
    return Response.json(replicas, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetScalingEvents(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
    const events = db.getScalingEvents(appId);
    return Response.json(events, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetAppMetrics(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
    // Serve the reconciler's already-persisted per-replica metrics
    // (cpu_percent / memory_percent, refreshed every ≤30s tick) rather than a
    // per-request SSH `docker stats` fan-out across every replica.
    const replicas = db.getReplicas(appId);
    return Response.json(replicas, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetAppMetricsHistory(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "metrics.view", appScope(appId));
    const url = new URL(request.url);
    const sinceSec = Math.max(60, Math.min(86400, parseInt(url.searchParams.get("since") || "3600", 10)));
    const samples = db.getRecentAppMetrics(appId, sinceSec);
    return Response.json({ samples, since: sinceSec }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** Resolve a server reference (name or numeric id) the same way placement does. */
function resolveServerRef(ref: unknown): db.ServerRow {
  const text = String(ref ?? "").trim();
  const placement = resolvePlacement({ [text]: 1 }, db.getServers());
  return db.getServer(Number(Object.keys(placement)[0]))!;
}

/** POST /api/apps/:appId/move { to, from? } — move every replica the app runs
 * on `from` to `to` and record the new placement. `from` may be omitted when
 * the app is placed on exactly one server. */
export async function handleMoveApp(request: Request, appId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "scaling.migrate", appScope(appId));
    const body = await request.json().catch(() => ({})) as { to?: unknown; from?: unknown };
    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });
    if (body.to === undefined || body.to === null || body.to === "") {
      return Response.json({ error: "to is required" }, { status: 400, headers: corsHeaders });
    }
    const placed = Object.keys(parsePlacement(app.placement)).map(Number);
    let target: db.ServerRow;
    let sourceId: number | undefined;
    try {
      target = resolveServerRef(body.to);
      if (body.from !== undefined && body.from !== null && body.from !== "") sourceId = resolveServerRef(body.from).id;
    } catch (error) {
      return Response.json({ error: (error as Error).message.replace(/^Placement server/, "Server") }, { status: 400, headers: corsHeaders });
    }
    if (sourceId === undefined) {
      if (placed.length !== 1) {
        const names = placed.map((id) => db.getServer(id)?.name ?? `#${id}`).join(", ");
        return Response.json(
          { error: placed.length === 0 ? `App ${app.name} has no placement yet` : `App ${app.name} runs on several servers (${names}); pass --from` },
          { status: 400, headers: corsHeaders },
        );
      }
      sourceId = placed[0];
    }
    if (!placed.includes(sourceId)) {
      return Response.json({ error: `App ${app.name} is not placed on ${db.getServer(sourceId)?.name ?? `#${sourceId}`}` }, { status: 400, headers: corsHeaders });
    }

    const { opId } = enqueue({
      kind: "move",
      resourceKeys: [`app:${appId}`],
      input: { appId, fromServerId: sourceId, toServerId: target.id },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
