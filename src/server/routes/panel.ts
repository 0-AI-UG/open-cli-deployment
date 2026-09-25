// Panel (hosted self) routes. Deliberately minimal: view state, redeploy,
// view logs, view deployment history. No scale, no env editing, no delete.
import { corsHeaders } from "../lib/cors.ts";
import { requireAdmin } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import { redeployPanel, getPanelContainerLogs } from "../../engine/deploy/panel.ts";
import { reconcilePanelDns } from "../../engine/dns-reconciler.ts";
import { latestMainPanelRelease } from "../lib/panel-main-release.ts";

export async function handleGetPanel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const panel = db.getPanel();
    if (!panel) {
      return Response.json({ panel: null }, { headers: corsHeaders });
    }
    const {
      env_vars: _envVars,
      ...safePanel
    } = panel;
    const server = db.getServer(panel.server_id);
    return Response.json(
      {
        panel: safePanel,
        server: server || null,
        deploy_log: db.getPanelDeployLog(),
        dns_instruction: await reconcilePanelDns(),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployPanel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json() as { image?: string; commit?: string };
    if (!body.image) {
      return Response.json({ ok: false, error: "image is required" }, { status: 400, headers: corsHeaders });
    }
    const result = await redeployPanel((_step, _detail) => {
      // Progress goes to logs; no SSE for the minimal panel UI.
    }, { image: body.image, commit: body.commit, source: "release" });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetLatestPanelRelease(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const panel = db.getPanel();
    if (!panel) return Response.json({ error: "Panel is not configured" }, { status: 409, headers: corsHeaders });
    const release = await latestMainPanelRelease();
    return Response.json({ ...release, currentImage: panel.image_ref, upToDate: panel.image_ref === release.image }, {
      headers: { ...corsHeaders, "cache-control": "no-store" },
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleRedeployLatestPanel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const panel = db.getPanel();
    if (!panel) return Response.json({ error: "Panel is not configured" }, { status: 409, headers: corsHeaders });
    const body = await request.json() as { commit?: unknown; image?: unknown };
    const release = await latestMainPanelRelease();
    if (body.commit !== release.commit || body.image !== release.image) {
      return Response.json({ error: "Main changed since you opened this release. Refresh the target and confirm again." }, { status: 409, headers: corsHeaders });
    }
    const result = await redeployPanel(() => {}, { ...release, source: "admin-main-release" });
    return Response.json({ ...result, ...release }, { status: result.ok ? 200 : 502, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetPanelLogs(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const url = new URL(request.url);
    const tail = parseInt(url.searchParams.get("tail") || "200", 10);
    const logs = await getPanelContainerLogs(tail);
    return Response.json({ logs }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleGetPanelDeployments(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const deployments = db.getPanelDeployments();
    return Response.json(deployments, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
