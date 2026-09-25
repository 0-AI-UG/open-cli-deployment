import { isNtfyApp, validateNtfyApp } from "../../engine/ntfy/service.ts";
import { findActiveOperationByResourceKey } from "../../shared/db/operations.ts";
import * as db from "../../shared/db.ts";
import { requireAdmin, requireAuthenticated } from "../lib/permissions.ts";
import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { ntfySettings, ntfyPreferences, ensureNtfyCredential, credentialSecret, ntfyCredentials, ntfyApp, ntfyUrl } from "../../shared/ntfy.ts";
import { NtfySettingsSchema, NtfyPreferencesSchema, CreateNtfyAppSchema } from "../../shared/ntfy-schema.ts";
import { enqueueNtfyTest } from "../../engine/ntfy/alerts.ts";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...corsHeaders, "cache-control": "no-store" } });
export async function handleAdminNtfy(request: Request): Promise<Response> {
  try {
    const actor = await requireAdmin(request);
    if (request.method === "PUT") {
      const parsed = NtfySettingsSchema.safeParse(await request.json());
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message || "Invalid ntfy settings" }, 400);
      const settings = parsed.data;
      const old = ntfySettings();
      if (old?.app_id && old.app_id !== settings.app_id && db.getApp(old.app_id)) return json({ error: "Manage the current ntfy app from its app page; remove it before selecting a replacement" }, 409);
      if (settings.app_id) {
        const app = db.getApp(settings.app_id);
        if (!app) return json({ error: "App not found" }, 404);
        try { validateNtfyApp(app); } catch (error) { return json({ error: (error as Error).message }, 400); }
      } else if (settings.enabled) return json({ error: "Create or select an ntfy app first" }, 400);
      if (findActiveOperationByResourceKey("configure_ntfy", "service:ntfy")) return json({ error: "Notification configuration is still applying" }, 409);
      const result = db.default.transaction(() => {
        db.saveSetting("ntfy_settings", JSON.stringify(settings));
        const operation = enqueue({ kind: "configure_ntfy", resourceKeys: ["service:ntfy"], input: {}, trigger: "ui", triggeredBy: actor.userId });
        db.saveSetting("ntfy_operation_id", String(operation.opId));
        return operation;
      })();
      return json(result, 202);
    }
    const s = db.getSettings();
    const counts = db.default.query("SELECT count(*) AS pending, sum(CASE WHEN attempts>=12 THEN 1 ELSE 0 END) AS failed FROM ntfy_outbox WHERE sent_at IS NULL").get();
    const app = ntfyApp();
    return json({ settings: ntfySettings(), opId: Number(s.ntfy_operation_id) || null,
      app: app ? { id: app.id, name: app.name, status: app.status, domain: app.domain } : null,
      status: app?.status || "unconfigured", delivery: counts,
      apps: db.getApps().filter(isNtfyApp).map(a => ({ id: a.id, name: a.name, status: a.status })),
      servers: db.getServers().filter(s => s.status === "ready" && s.pool !== "build-workers").map(s => ({ id: s.id, name: s.name })),
    });
  } catch (error) { return handleError(error); }
}
export async function handleUserNtfy(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const settings = ntfySettings();
    if (request.method === "PUT") {
      const parsed = NtfyPreferencesSchema.safeParse(await request.json());
      if (!parsed.success) return json({ error: "Invalid notification preferences" }, 400);
      if (parsed.data.enabled && (!settings?.enabled || !settings.alerts || !ntfyApp())) return json({ error: "Ask an administrator to enable ntfy alerts first" }, 409);
      if (parsed.data.enabled) await ensureNtfyCredential("user", actor.userId);
      const result = db.default.transaction(() => {
        db.saveSetting(`ntfy_user.${actor.userId}`, JSON.stringify(parsed.data));
        const operation = enqueue({ kind: "configure_ntfy", resourceKeys: ["service:ntfy"], input: {}, trigger: "ui", triggeredBy: actor.userId });
        db.saveSetting("ntfy_operation_id", String(operation.opId));
        return operation;
      })();
      return json(result, 202);
    }
    const preferences = ntfyPreferences(actor.userId);
    const credential = ntfyCredentials().find(c => c.owner_type === "user" && c.owner_id === actor.userId);
    const delivery = db.default.query("SELECT title,sent_at,error,attempts FROM ntfy_outbox WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(actor.userId);
    return json({ available: !!settings?.enabled && settings.alerts && !!ntfyApp(), preferences, status: ntfyApp()?.status || "unconfigured", delivery,
      connection: settings && ntfyApp()?.domain && credential && preferences.enabled ? { url: ntfyUrl(), topic: credential.topic, username: credential.username } : null });
  } catch (error) { return handleError(error); }
}
export async function handleNtfyCredentials(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    if (!ntfyPreferences(actor.userId).enabled) return json({ error: "Enable notifications first" }, 409);
    const credential = await ensureNtfyCredential("user", actor.userId);
    return json(await credentialSecret(credential));
  } catch (error) { return handleError(error); }
}
export async function handleNtfyTest(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const settings = ntfySettings();
    if (!settings?.enabled || !settings.alerts || !ntfyPreferences(actor.userId).enabled) return json({ error: "Enable notifications first" }, 409);
    const recent = db.default.query("SELECT 1 FROM ntfy_outbox WHERE user_id=? AND incident_key='test' AND created_at>?").get(actor.userId, Date.now() - 60_000);
    if (recent) return json({ error: "Wait one minute before sending another test" }, 429);
    return json({ id: enqueueNtfyTest(actor.userId), queued: true }, 202);
  } catch (error) { return handleError(error); }
}

export async function handleCreateNtfyApp(request: Request): Promise<Response> {
  try {
    const actor = await requireAdmin(request);
    const parsed = CreateNtfyAppSchema.safeParse(await request.json());
    if (!parsed.success) return json({ error: "Provide an app name, HTTPS domain, and server" }, 400);
    if (ntfyApp()) return json({ error: "The ntfy app already exists; open its app page" }, 409);
    if (findActiveOperationByResourceKey("configure_ntfy", "service:ntfy")) return json({ error: "ntfy app creation is already in progress" }, 409);
    const input = parsed.data;
    const server = db.getServer(input.server_id);
    if (!server || server.status !== "ready" || server.pool === "build-workers") return json({ error: "Select a ready application server" }, 400);
    if (db.getAppByName(input.name) || db.getApps().some(a => a.domain === input.domain) || db.getPanel()?.domain === input.domain) return json({ error: "App name or domain is already in use" }, 409);
    const operation = db.default.transaction(() => {
      db.saveSetting("ntfy_settings", JSON.stringify(NtfySettingsSchema.parse({ enabled: true, app_id: null, alerts: true, apps: true })));
      const op = enqueue({ kind: "configure_ntfy", resourceKeys: ["service:ntfy"], input: { create: input }, trigger: "ui", triggeredBy: actor.userId });
      db.saveSetting("ntfy_operation_id", String(op.opId));
      return op;
    })();
    return json(operation, 202);
  } catch (error) { return handleError(error); }
}
