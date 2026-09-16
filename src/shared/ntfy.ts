import { createHash, randomBytes } from "node:crypto";
import db, { getSettings, saveSetting, getApp, getUserById, hasPermission } from "./db.ts";
import { encryptValue, decryptValue } from "./secret-store.ts";
import { NtfyBindingsSchema, type NtfyBindings, type NtfyPreferences, type NtfySettings } from "./ntfy-schema.ts";
export const NTFY_IMAGE = "docker.io/binwiederhier/ntfy:v2.28.0";
export const NTFY_CONTAINER = "ocd-ntfy";
export const NTFY_PORT = 8894;
export const ntfySettings = (): NtfySettings | null => JSON.parse(getSettings().ntfy_settings || "null");
export const ntfyPreferences = (id: string): NtfyPreferences => JSON.parse(getSettings()[`ntfy_user.${id}`] || '{"enabled":false,"events":["app","delivery","disk","backup"],"recovery":true}');
export const getAppNtfy = (id: number): NtfyBindings => JSON.parse(getSettings()[`app_ntfy.${id}`] || "{}");
export const ntfyHash = (value: string) => createHash("sha256").update(value).digest("hex");
export type NtfyCredential = { id: string; owner_type: string; owner_id: string; binding: string; permissions: string; generation: number; topic: string; username: string; password_hash: string; encrypted_value: string; iv: string };
export const ntfyCredentials = () => db.query("SELECT * FROM ntfy_credentials ORDER BY id").all() as NtfyCredential[];
export const credentialSecret = async (row: NtfyCredential): Promise<{ password: string; token: string }> => JSON.parse(await decryptValue(row.encrypted_value, row.iv));
export async function ensureNtfyCredential(ownerType: "user" | "app" | "system", ownerId: string, binding = "primary", generation = 0, permissions = "ro"): Promise<NtfyCredential> {
  const id = ntfyHash(JSON.stringify([ownerType, ownerId, binding, generation, permissions]));
  const existing = db.query("SELECT * FROM ntfy_credentials WHERE id=?").get(id) as NtfyCredential | null;
  if (existing) return existing;
  const password = randomBytes(32).toString("hex");
  const token = `tk_${randomBytes(29).toString("hex").slice(0, 29)}`;
  const encrypted = await encryptValue(JSON.stringify({ password, token }));
  const hash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
  // Concurrent requests converge on one credential, including across panel/engine processes.
  db.query("INSERT OR IGNORE INTO ntfy_credentials (id,owner_type,owner_id,binding,permissions,generation,topic,username,password_hash,encrypted_value,iv) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ownerType, ownerId, binding, permissions, generation, `ocd-${ownerType}-${id.slice(0, 32)}`, `ocd-${id.slice(0, 32)}`, hash, encrypted.encrypted_value, encrypted.iv);
  return db.query("SELECT * FROM ntfy_credentials WHERE id=?").get(id) as NtfyCredential;
}
export function normalizeNtfyBindings(value: NtfyBindings = {}): NtfyBindings {
  return Object.fromEntries(Object.entries(NtfyBindingsSchema.parse(value)).sort(([a], [b]) => a.localeCompare(b)).map(([name, spec]) => [name, { ...spec, permissions: [...new Set(spec.permissions)].sort() }]));
}
export async function prepareNtfyBindings(appId: number, bindings: NtfyBindings): Promise<void> {
  if (!Object.keys(bindings).length) return;
  const settings = ntfySettings();
  if (!settings?.enabled || !settings.apps) throw new Error("Enable the shared ntfy service and app access in Admin first");
  for (const [name, spec] of Object.entries(bindings)) await ensureNtfyCredential("app", String(appId), name, spec.generation, ntfyAccess(spec));
}
export function saveAppNtfy(appId: number, bindings: NtfyBindings, initial = false): void {
  const value = JSON.stringify(normalizeNtfyBindings(bindings));
  if (JSON.stringify(getAppNtfy(appId)) === value) return;
  db.transaction(() => {
    saveSetting(`app_ntfy.${appId}`, value);
    if (!initial) db.query("UPDATE apps SET config_revision=config_revision+1 WHERE id=?").run(appId);
  })();
}
export function deleteAppNtfy(appId: number): void {
  db.query("DELETE FROM settings WHERE key=?").run(`app_ntfy.${appId}`);
  db.query("DELETE FROM ntfy_credentials WHERE owner_type='app' AND owner_id=?").run(String(appId));
}
export function ntfyVariableNames(name: string) {
  const prefix = name === "primary" ? "OCD_NTFY" : `OCD_${name.toUpperCase()}_NTFY`;
  return { url: `${prefix}_URL`, topic: `${prefix}_TOPIC`, token: `${prefix}_TOKEN` };
}
export async function appNtfyEnv(appId: number, bindings = getAppNtfy(appId)): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!Object.keys(bindings).length) return result;
  const settings = ntfySettings();
  if (!settings?.enabled || !settings.apps) throw new Error("Shared ntfy app access is disabled");
  for (const [name, spec] of Object.entries(bindings)) {
    const credential = await ensureNtfyCredential("app", String(appId), name, spec.generation, ntfyAccess(spec));
    const names = ntfyVariableNames(name);
    result[names.url] = `https://${settings.domain}`;
    result[names.topic] = credential.topic;
    result[names.token] = (await credentialSecret(credential)).token;
  }
  return result;
}
/** Recheck at delivery time; a queued message must not bypass a revoked grant. */
export function canReceiveNtfy(userId: string, key: string, recovered: boolean): boolean {
  const user = getUserById(userId);
  const prefs = ntfyPreferences(userId);
  const category = key.split(":")[0] as NtfyPreferences["events"][number];
  if (!user || !prefs.enabled || !prefs.events.includes(category) || (recovered && !prefs.recovery)) return false;
  if (user.is_admin) return true;
  if (category === "app") {
    const appId = Number(key.slice(4));
    return !!getApp(appId) && hasPermission(userId, "apps.view", { appId });
  }
  // Delivery targets may include several resources. Until each target is resolved,
  // fleet and backup incidents are admin-only rather than leaking operation names.
  return false;
}

export function ntfyAccess(spec: NtfyBindings[string]): string {
  return spec.permissions.includes("publish") ? (spec.permissions.includes("subscribe") ? "rw" : "wo") : "ro";
}
/** Keep old credentials through rollout, just like object-storage grants. */
export function retireAppNtfyCredentials(appId: number): void {
  const desired = getAppNtfy(appId);
  for (const c of ntfyCredentials().filter(c => c.owner_type === "app" && c.owner_id === String(appId))) {
    const spec = desired[c.binding];
    if (!spec || spec.generation !== c.generation || ntfyAccess(spec) !== c.permissions) {
      db.query("DELETE FROM ntfy_credentials WHERE id=?").run(c.id);
    }
  }
}

export function appNtfyView(appId: number) {
  return Object.entries(getAppNtfy(appId)).map(([name, spec]) => ({ name, ...spec, variables: ntfyVariableNames(name), injected_by: "Notifications" }));
}
