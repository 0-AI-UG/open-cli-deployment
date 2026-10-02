import { corsHeaders } from "../lib/cors.ts";
import { requirePermission, requireCliPermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import * as db from "../../shared/db.ts";
import type { StackDeployRequest } from "../../shared/rpc.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { findActiveOperationByResourceKey, listChildOperations } from "../../shared/db/operations.ts";
import { getContainerLogs, sshExec } from "../../shared/remote/index.ts";
import { deriveStackResourceState } from "../../engine/resource-state.ts";
import { findLatestRelatedStackOperation, stackLockKeys } from "../lib/stack-operations.ts";
import { validatePublicEndpoint } from "../../engine/dns-reconciler.ts";
import { assertPlacementChangeAllowed, assertPlacementUsable, resolveRequestPlacement } from "../../shared/app-config.ts";
import { enrichAppForResponse } from "./apps.ts";
import { resolveOciImage } from "../../engine/oci-image.ts";
import { validateBuildDeployRequest, validateDeployRequest } from "../../shared/validate.ts";
import { validateStackReferences } from "../../shared/stack-spec.ts";

const TERMINAL_OPERATION_STATUSES = new Set([
  "done",
  "failed",
  "cancelled",
  "compensated",
  "compensation_failed",
]);

function operationFields(stack: db.StackRow, fallback: ReturnType<typeof deriveStackResourceState>) {
  const latest = findLatestRelatedStackOperation(stack);
  if (!latest) {
    return {
      last_operation_id: fallback.lastOperationId,
      last_operation_status: fallback.lastOperationStatus,
      last_operation_failed: fallback.lastOperationFailed,
      operation_in_progress: fallback.operationInProgress,
      last_operation_children: [],
    };
  }
  return {
    last_operation_id: latest.id,
    last_operation_status: latest.status,
    last_operation_failed: ["failed", "compensated", "compensation_failed"].includes(latest.status),
    operation_in_progress: !TERMINAL_OPERATION_STATUSES.has(latest.status),
    last_operation_children: listChildOperations(latest.id).map((child) => ({
      id: child.id,
      kind: child.kind,
      status: child.status,
    })),
  };
}

// --- Deploy ---

export async function handleDeployStack(request: Request): Promise<Response> {
  try {
    const payload = await requireCliPermission(request, "stacks.deploy");
    const req: StackDeployRequest = await request.json();
    for (const field of ["env_vars", "staging_env_vars", "staging_env_keys"]) {
      if (field in req) return Response.json({ ok: false, error: `${field} is not supported; configure environments separately` }, { status: 400, headers: corsHeaders });
    }
    if (req.apps?.some(app => app.storage && Object.keys(app.storage).length)) await requirePermission(request, "apps.storage.bind");
    if (req.apps?.some(app => app.notifications && Object.keys(app.notifications).length)) await requirePermission(request, "apps.notifications.bind");
    if (!req?.name || typeof req.name !== "string") {
      return Response.json({ ok: false, error: "name is required" }, { status: 400, headers: corsHeaders });
    }
    if (!Array.isArray(req.apps) || req.apps.length === 0) {
      return Response.json({ ok: false, error: "apps must be a non-empty array" }, { status: 400, headers: corsHeaders });
    }
    const invalidSource = req.apps.find((app) => Boolean(app.build) === Boolean(app.image_ref));
    if (invalidSource) {
      return Response.json(
        { ok: false, error: `Stack app ${invalidSource.key} requires exactly one delivery source: build or image_ref` },
        { status: 400, headers: corsHeaders },
      );
    }
    for (const app of req.apps ?? []) app.delivery_source = app.build ? "build" : "image";
    // Single-flight: only one deploy_stack per stack may run at a time. If one is
    // already in flight (pending/running/compensating), attach to it — follow the
    // existing run — instead of enqueuing a duplicate.
    const resourceKey = `stack:${req.name}`;
    const existing = findActiveOperationByResourceKey("deploy_stack", resourceKey);
    if (existing) {
      return Response.json({ op_id: existing.id, attached: true }, { headers: corsHeaders });
    }
    const stack = db.getStackByName(req.name);
    const selectedApps = req.selected_app_keys
      ? req.apps.filter((app) => req.selected_app_keys!.includes(app.key))
      : req.apps;
    // The engine validates the complete stack, including retained members.
    // Preserve their deployed digest instead of passing an unselected manifest
    // tag into validate_plan, which would fail an otherwise valid partial deploy.
    const selectedKeys = new Set(selectedApps.map((app) => app.key));
    for (const app of req.apps) {
      const existingApp = db.getAppByName(`${req.name}-${app.key}`);
      if (!selectedKeys.has(app.key) && existingApp?.image_ref) {
        app.image_ref = existingApp.image_ref;
        app.build = undefined;
        continue;
      }
      if (req.config_only && existingApp) {
        app.image_ref = existingApp.image_ref;
        app.build = undefined;
        continue;
      }
      if (app.build || !app.image_ref) continue;
      app.image_ref = await resolveOciImage(app.image_ref);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(req.name)) {
      return Response.json({ ok: false, error: "Stack name must contain only lowercase letters, digits, and hyphens" }, { status: 400, headers: corsHeaders });
    }
    const appKeys = new Set(req.apps.map((app) => app.key));
    if (appKeys.size !== req.apps.length) {
      return Response.json({ ok: false, error: "Stack app keys must be unique" }, { status: 400, headers: corsHeaders });
    }
    try {
      validateStackReferences(req.apps);
    } catch (error) {
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 400, headers: corsHeaders },
      );
    }
    for (const key of req.selected_app_keys ?? []) {
      if (!appKeys.has(key)) return Response.json({ ok: false, error: `Selected app key "${key}" is not declared in the stack` }, { status: 400, headers: corsHeaders });
    }
    for (const app of req.apps) {
      const spec = { ...app, app_name: `${req.name}-${app.key}` };
      const validation = app.build && !app.image_ref
        ? validateBuildDeployRequest(spec)
        : validateDeployRequest(spec);
      if (!validation.valid) {
        return Response.json({ ok: false, error: `App "${app.key}": ${validation.error}` }, { status: 400, headers: corsHeaders });
      }
    }
    for (const app of selectedApps) {
      // Placement is explicit: every named server must exist and be usable,
      // and a volume member never changes servers outside `ocd move`.
      try {
        const placement = resolveRequestPlacement(app);
        const existingApp = db.getAppByName(`${req.name}-${app.key}`);
        if (existingApp) assertPlacementChangeAllowed(existingApp, app.volume_size ?? 0, placement);
        else assertPlacementUsable(placement);
      } catch (error) {
        return Response.json({ ok: false, error: `App "${app.key}": ${(error as Error).message}` }, { status: 400, headers: corsHeaders });
      }
    }
    const selectedBuildApps = selectedApps.filter((app) => !!app.build && !app.image_ref);
    if (!req.config_only && selectedBuildApps.length > 0) {
      const { opId } = enqueue({
        kind: "build_stack_delivery",
        resourceKeys: [`build-stack:${req.name}`],
        input: { spec: req, userId: payload.userId },
        trigger: "cli",
        triggeredBy: payload.userId,
      });
      return Response.json({ op_id: opId }, { status: 202, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "deploy_stack",
      resourceKeys: stack ? stackLockKeys(stack) : [`stack:${req.name}`],
      input: req,
      trigger: "cli",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- List ---

export async function handleGetStacks(request: Request): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    const stacks = db.getStacks();
    const result = stacks.map((s) => {
      const apps = db.getAppsByStackId(s.id);
      const resourceState = deriveStackResourceState(s);
      return {
        ...s,
        status: resourceState.status,
        resource_status_reason: resourceState.reason,
        ...operationFields(s, resourceState),
        app_count: apps.length,
      };
    });
    return Response.json(result, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Detail ---

export async function handleGetStack(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const resourceState = deriveStackResourceState(stack);
    const apps = db.getAppsByStackId(stackId);
    const validateEndpoints = new URL(request.url).searchParams.get("validate_endpoints") === "1";
    const publicEndpoints = validateEndpoints
      ? await Promise.all(apps.filter((app) => app.public && app.domain).map(async (app) => {
          try {
            return {
              app_id: app.id,
              app_name: app.name,
              ...(await validatePublicEndpoint(app.id)),
            };
          } catch (err) {
            const current = db.getApp(app.id);
            return {
              app_id: app.id,
              app_name: app.name,
              domain: app.domain,
              managed: false,
              expectedTarget: "",
              resolved: [] as string[],
              ready: false,
              tlsReady: false,
              tlsError: current?.public_endpoint_error || (err instanceof Error ? err.message : String(err)),
            };
          }
        }))
      : [];
    const endpointDegraded = publicEndpoints.some((endpoint) => !endpoint.ready || !endpoint.tlsReady);
    let acme_errors: string[] = [];
    if (validateEndpoints && endpointDegraded) {
      const panel = db.getPanel();
      const server = panel ? db.getServer(panel.server_id) : null;
      if (server) {
        const logs = await sshExec(
          server.ipv4,
          "journalctl -u ocd-traefik -n 250 --no-pager 2>/dev/null | grep -iE 'acme|certificate|challenge' | tail -20 || true",
          server.ssh_host_key || undefined,
        ).catch(() => null);
        acme_errors = logs?.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) ?? [];
      }
    }
    return Response.json({
      ...stack,
      status: endpointDegraded && resourceState.status === "running" ? "degraded" : resourceState.status,
      resource_status_reason: endpointDegraded
        ? `${resourceState.reason}; one or more public endpoints are not HTTPS-ready`
        : resourceState.reason,
      ...operationFields(stack, resourceState),
      apps: apps.map((app) => enrichAppForResponse(app as db.AppRow & Record<string, unknown>)),
      public_endpoints: publicEndpoints,
      acme_errors,
    }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Log ---

export async function handleGetStackLog(request: Request, stackId: number): Promise<Response> {
  try {
    await requirePermission(request, "stacks.view");
    return Response.json({ log: db.getStackLog(stackId) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * GET /api/stacks/:id/member-logs?tail=N — container logs of every member, in
 * one round trip.
 *
 * A stack is only interesting as a whole: a request crosses three of its apps
 * and a database, so reading one member's log at a time is the wrong unit. We
 * fan out over the members' primary replica, ask docker for
 * timestamped lines, and hand the client one block per member. Interleaving and
 * per-member filtering happen client-side so toggling a member off is instant
 * and doesn't re-run N ssh calls.
 *
 * Gated on `apps.logs` on top of `stacks.view`: this returns container output,
 * which is strictly more than the stack metadata `stacks.view` covers. Because
 * the response is already a per-member list that tolerates missing blocks, the
 * `apps.logs` check is applied per member and members the caller may not read
 * are simply omitted, rather than failing the whole request.
 */
export async function handleGetStackMemberLogs(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.view");
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const tail = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("tail") || "100", 10) || 100, 1), 1000);

    // Container output additionally needs `apps.logs`; without it the stack
    // view still loads, just with no member output.
    const apps = db.hasPermission(payload.userId, "apps.logs") ? db.getAppsByStackId(stackId) : [];

    const fetchApp = async (app: { id: number; name: string }) => {
      const replicas = db.getReplicas(app.id);
      if (replicas.length === 0) throw new Error("No replicas");
      const replica = replicas[0];
      const server = db.getServer(replica.server_id);
      if (!server) throw new Error("Server not found");
      return getContainerLogs(server.ipv4, replica.container_name, tail, server.ssh_host_key || undefined, true);
    };

    // One slow or unreachable member must not blank the whole view, so each
    // failure is reported in its own block and the rest still render.
    const members = await Promise.all([
      ...apps.map(async (a) => {
        try {
          return { kind: "app" as const, id: a.id, name: a.name, logs: await fetchApp(a) };
        } catch (err) {
          return { kind: "app" as const, id: a.id, name: a.name, logs: "", error: err instanceof Error ? err.message : String(err) };
        }
      }),
    ]);

    return Response.json({ members }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// --- Lifecycle ---

export async function handleDestroyStack(request: Request, stackId: number): Promise<Response> {
  try {
    const payload = await requirePermission(request, "stacks.destroy");
    await enforceConfirmation(request, payload, "delete_stack", "stack", String(stackId));
    const stack = db.getStack(stackId);
    if (!stack) {
      return Response.json({ ok: false, error: "Stack not found" }, { status: 404, headers: corsHeaders });
    }
    const { opId } = enqueue({
      kind: "destroy_stack",
      resourceKeys: stackLockKeys(stack),
      input: { stackId },
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    return Response.json({ op_id: opId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
