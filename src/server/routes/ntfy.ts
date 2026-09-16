import * as db from "../../shared/db.ts";
import { requireAdmin, requireAuthenticated } from "../lib/permissions.ts";
import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import { enqueue } from "../ipc/enqueue.ts";
import { ntfySettings, ntfyPreferences, ensureNtfyCredential, credentialSecret, ntfyCredentials, getAppNtfy } from "../../shared/ntfy.ts";
import { NtfySettingsSchema, NtfyPreferencesSchema } from "../../shared/ntfy-schema.ts";
import { enqueueNtfyTest } from "../../engine/ntfy/alerts.ts";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { ...corsHeaders, "cache-control": "no-store" } });
export async function handleAdminNtfy(request: Request): Promise<Response> {
  try {
    const actor = await requireAdmin(request);
    if (request.method === "PUT") {
      const parsed = NtfySettingsSchema.safeParse(await request.json());
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message || "Invalid ntfy settings" }, 400);
      const settings = parsed.data;
      if (!db.getPanel()) return json({ error: "Deploy the panel before provisioning ntfy" }, 409);
      if (settings.enabled && (settings.domain === db.getPanel()?.domain || db.getApps().some(a => a.domain === settings.domain))) return json({ error: "Domain is already in use" }, 409);
      const old = ntfySettings();
      if (old && old.domain !== settings.domain && db.getApps().some(app => Object.keys(getAppNtfy(app.id)).length)) return json({ error: "Remove app notification bindings before changing the service domain" }, 409);
      const result = db.default.transaction(() => {
        db.saveSetting("ntfy_settings", JSON.stringify(settings));
        db.saveSetting("ntfy_status", "pending");
        if (settings.alerts && !old?.alerts) db.saveSetting("panel_alert_enabled_at", String(Date.now()));
        const operation = enqueue({ kind: "configure_ntfy", resourceKeys: ["service:ntfy"], input: {}, trigger: "ui", triggeredBy: actor.userId });
        db.saveSetting("ntfy_operation_id", String(operation.opId));
        return operation;
      })();
      return json(result, 202);
    }
    const s = db.getSettings();
    const counts = db.default.query("SELECT count(*) AS pending, sum(CASE WHEN attempts>=12 THEN 1 ELSE 0 END) AS failed FROM ntfy_outbox WHERE sent_at IS NULL").get();
    return json({ settings: ntfySettings(), opId: Number(s.ntfy_operation_id) || null, status: s.ntfy_status || "unconfigured", checked_at: s.ntfy_checked_at || null, image: s.ntfy_image_digest || null, delivery: counts });
  } catch (error) { return handleError(error); }
}
export async function handleUserNtfy(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const settings = ntfySettings();
    if (request.method === "PUT") {
      const parsed = NtfyPreferencesSchema.safeParse(await request.json());
      if (!parsed.success) return json({ error: "Invalid notification preferences" }, 400);
      if (parsed.data.enabled && (!settings?.enabled || !settings.alerts)) return json({ error: "Ask an administrator to enable ntfy alerts first" }, 409);
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
    return json({ available: !!settings?.enabled && settings.alerts, preferences, status: db.getSettings().ntfy_status || "unconfigured", delivery,
      connection: settings && credential && preferences.enabled ? { url: `https://${settings.domain}`, topic: credential.topic, username: credential.username } : null });
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
