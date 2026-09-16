import * as db from "../../shared/db.ts";
import { processIncomingEnvVars, resolveEnvVarsForDeploy, parseEnvVars } from "../../shared/env-crypto.ts";
import { parseRuntimeConfig } from "../../shared/runtime-env.ts";
import { applyAppConfig, deployRequestFromApp } from "../../shared/app-config.ts";
import { enqueueOperation, getOperation, findActiveOperationByResourceKey } from "../../shared/db/operations.ts";
import { recoveryPending } from "../panel-protection/recovery-state.ts";
import { ntfySettings, ntfyApp, ntfyCredentials, ntfyPreferences, ensureNtfyCredential, credentialSecret, type NtfyCredential } from "../../shared/ntfy.ts";
import type { NtfySettings } from "../../shared/ntfy-schema.ts";
import { tryAcquire, release, NON_OP_HOLDER } from "../scheduler.ts";
import type { OpContext } from "../types.ts";

export function isNtfyApp(app: { image_ref: string }): boolean {
  return /^(?:docker\.io\/)?binwiederhier\/ntfy@sha256:[a-f0-9]{64}$/.test(app.image_ref);
}
export function renderNtfyEnvironment(settings: NtfySettings, domain: string, credentials: Array<NtfyCredential & { token: string; access: string }>): Record<string, string> {
  return {
    NTFY_BASE_URL: `https://${domain}`,
    NTFY_CACHE_DURATION: `${settings.cache_hours}h`,
    NTFY_UPSTREAM_BASE_URL: settings.ios_push ? "https://ntfy.sh" : "",
    NTFY_AUTH_USERS: credentials.map(c => `${c.username}:${c.password_hash}:user`).join(","),
    NTFY_AUTH_TOKENS: credentials.map(c => `${c.username}:${c.token}`).join(","),
    NTFY_AUTH_ACCESS: credentials.map(c => `${c.username}:${c.owner_type === "system" ? "ocd-user-*" : c.topic}:${c.access}`).join(","),
  };
}
export async function ntfyEnvironment(settings: NtfySettings, domain: string): Promise<Record<string, string>> {
  // The publisher identity remains provisioned with no access while integration
  // is disabled, ensuring empty lists still revoke all former ACLs on restart.
  await ensureNtfyCredential("system", "events");
  const credentials: Array<NtfyCredential & { token: string; access: string }> = [];
  for (const c of ntfyCredentials()) {
    let access = "";
    if (c.owner_type === "system") access = settings.enabled && settings.alerts ? "wo" : "none";
    if (settings.enabled && c.owner_type === "user" && settings.alerts && db.getUserById(c.owner_id) && ntfyPreferences(c.owner_id).enabled) access = "ro";
    if (settings.enabled && c.owner_type === "app" && settings.apps && db.getApp(Number(c.owner_id))) access = c.permissions;
    if (access) credentials.push({ ...c, token: (await credentialSecret(c)).token, access });
  }
  return renderNtfyEnvironment(settings, domain, credentials);
}
export function validateNtfyApp(app: NonNullable<ReturnType<typeof db.getApp>>): void {
  if (!isNtfyApp(app)) throw new Error("Select an app running the official ntfy image");
  if (!app.domain) throw new Error("The ntfy app needs an HTTPS domain");
  if (!app.environment_id || !db.getEnvironment(app.environment_id)) throw new Error("The ntfy app needs its own environment");
  if (db.getApps().some(a => a.id !== app.id && a.environment_id === app.environment_id)) throw new Error("Use a dedicated environment for the ntfy app's credentials");
  if (app.desired_replicas !== 1 || !app.volume_mount.endsWith(":/var/lib/ntfy")) throw new Error("ntfy needs one replica and persistent storage at /var/lib/ntfy");
  const env = parseRuntimeConfig(app.env_vars).env;
  if (env.NTFY_AUTH_DEFAULT_ACCESS !== "deny-all" || env.NTFY_ENABLE_SIGNUP !== "false") throw new Error("The ntfy app must deny anonymous access and disable signup; use services/ntfy/.ocd-deploy.json");
}
let pending: Promise<number | null> | undefined;
/** Only synchronize integration credentials. App hosting is entirely standard OCD. */
export async function reconcileNtfyService(ctx?: OpContext, requireReady = false): Promise<void> {
  const stage = (pending ?? Promise.resolve()).catch(() => null).then(() => synchronize(ctx));
  pending = stage;
  ctx?.park();
  try {
    let operationId: number | null;
    try { operationId = await stage; }
    finally { if (pending === stage) pending = undefined; }
    if (ctx && operationId) {
      for (;;) {
        if (ctx.isCancelRequested()) throw new Error("Cancelled while waiting for ntfy app configuration");
        const op = getOperation(operationId);
        if (!op) throw new Error("ntfy app reload operation disappeared");
        if (op.status === "done") break;
        if (["failed", "cancelled", "compensated", "compensation_failed"].includes(op.status)) throw new Error(`ntfy app reload #${operationId} ${op.status}; inspect the app's deployment history`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } finally { ctx?.unpark(); }
  if (requireReady && ntfyApp()?.status !== "running") throw new Error("The ntfy app is not running; start it from its app page");
}
async function synchronize(ctx?: OpContext): Promise<number | null> {
  const settings = ntfySettings();
  const app = ntfyApp();
  if (!settings || !app || recoveryPending()) return null;
  const keys = [`app:${app.id}`];
  while (!tryAcquire(keys, NON_OP_HOLDER, "ntfy-config").ok) {
    if (!ctx) return null;
    if (ctx.isCancelRequested()) throw new Error("Cancelled waiting for ntfy app");
    await new Promise(r => setTimeout(r, 1000));
  }
  try { return await synchronizeApp(app.id, settings, ctx); }
  finally { release(keys); }
}
async function synchronizeApp(appId: number, settings: NtfySettings, ctx?: OpContext): Promise<number | null> {
  const app = db.getApp(appId);
  if (!app || app.deletion_requested_at) return null;
  validateNtfyApp(app);
  const env = db.getEnvironment(app.environment_id!)!;
  const desired = await ntfyEnvironment(settings, app.domain);
  const current = await resolveEnvVarsForDeploy(env.env_vars);
  if (Object.entries(desired).some(([key, value]) => current[key] !== value)) {
    const retained = parseEnvVars(env.env_vars).entries.filter(e => !Object.hasOwn(desired, e.key));
    const managed = await processIncomingEnvVars(Object.entries(desired).map(([key, value]) => ({ key, value, secret: key.startsWith("NTFY_AUTH_") })));
    db.updateEnvironment(env.id, env.name, JSON.stringify({ version: 2, entries: [...retained, ...managed.entries] }));
  }
  const runtime = parseRuntimeConfig(app.env_vars);
  const mapping = Object.fromEntries(Object.keys(desired).map(key => [key, { from: `environment.${key}` }]));
  if (Object.entries(mapping).some(([key, value]) => JSON.stringify(runtime.env[key]) !== JSON.stringify(value))) {
    await applyAppConfig(app.id, { ...deployRequestFromApp(db.getApp(app.id)!), env: { ...runtime.env, ...mapping } });
  }
  const updated = db.getApp(app.id)!;
  const replicas = db.getReplicas(app.id).filter(r => r.status === "running");
  if (replicas.length === updated.desired_replicas && replicas.every(r => r.attested_at && r.config_revision === updated.config_revision)) return null;
  // Respect ordinary lifecycle intent: integration must never restart a paused,
  // sleeping, deleting, or currently deploying app behind the operator's back.
  if (!["running", "unhealthy"].includes(updated.status)) return null;
  const active = findActiveOperationByResourceKey("reload_app", `app:${app.id}`);
  if (active) return active.id;
  const op = enqueueOperation({ kind: "reload_app", resourceKeys: [`app:${app.id}`], input: { appId: app.id }, trigger: "ntfy-config", triggeredBy: ctx?.triggeredBy ?? "system:ntfy", parentId: ctx?.opId });
  db.saveSetting("ntfy_operation_id", String(op.id));
  return op.id;
}
