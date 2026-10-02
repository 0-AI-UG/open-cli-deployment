import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, appScope } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";

/**
 * GET /api/apps/:appId/availability?window=<seconds>
 *
 * Returns the app's availability SLO over the trailing window (uptime% + MTTR
 * from the sampled history) plus a live `current` snapshot recomputed from the
 * app's replicas right now, using the same predicate the sampler uses.
 */
export async function handleGetAvailability(request: Request, appId: number): Promise<Response> {
  try {
    await requirePermission(request, "apps.view", appScope(appId));

    const app = db.getApp(appId);
    if (!app) return Response.json({ error: "App not found" }, { status: 404, headers: corsHeaders });

    const url = new URL(request.url);
    const parsed = parseInt(url.searchParams.get("window") || "", 10);
    const windowSec = Number.isFinite(parsed) && parsed > 0 ? parsed : 86400;

    const stats = db.getAvailabilityStats(appId, windowSec);

    // Live "current" snapshot — same computation as the reconciler sample.
    const current = db.currentAvailability(app);

    return Response.json(
      {
        uptimePct: stats.uptimePct,
        mttrSeconds: stats.mttrSeconds,
        sampleCount: stats.sampleCount,
        lastMeetsTarget: stats.lastMeetsTarget,
        current,
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
