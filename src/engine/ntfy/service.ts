import * as db from "../../shared/db.ts";
import { sshExecWithStdin } from "../../shared/remote/index.ts";
import { resolveOciImage } from "../oci-image.ts";
import { recoveryPending } from "../panel-protection/recovery-state.ts";
import { NTFY_CONTAINER, NTFY_IMAGE, NTFY_PORT, ntfySettings, ntfyCredentials, ntfyPreferences, ensureNtfyCredential, credentialSecret, ntfyHash, type NtfyCredential } from "../../shared/ntfy.ts";
import type { NtfySettings } from "../../shared/ntfy-schema.ts";

export function renderNtfyConfig(settings: NtfySettings, credentials: Array<NtfyCredential & { token: string; access: string }>): string {
  // JSON is valid YAML; secrets are written only via private stdin to a mode-0600 file.
  return JSON.stringify({
    "base-url": `https://${settings.domain}`, "listen-http": ":80",
    "cache-file": "/var/lib/ntfy/cache.db", "cache-duration": `${settings.cache_hours}h`,
    "auth-file": "/var/lib/ntfy/auth.db", "auth-default-access": "deny-all",
    "enable-login": true, "enable-signup": false, "enable-reservations": false,
    "behind-proxy": true,
    "visitor-request-limit-burst": 60, "visitor-request-limit-replenish": "5s",
    "visitor-subscription-limit": 30,
    ...(settings.ios_push ? { "upstream-base-url": "https://ntfy.sh" } : {}),
    "auth-users": credentials.map(c => `${c.username}:${c.password_hash}:user`),
    "auth-tokens": credentials.map(c => `${c.username}:${c.token}`),
    "auth-access": credentials.map(c => `${c.username}:${c.owner_type === "system" ? "ocd-user-*" : c.topic}:${c.access}`),
  }, null, 2);
}
export function renderNtfyIngress(domain: string): string {
  return JSON.stringify({ http: {
    routers: { "ocd-ntfy": { entryPoints: ["websecure"], rule: `Host(\`${domain}\`)`, service: "ocd-ntfy", tls: { certResolver: "letsencrypt" } } },
    services: { "ocd-ntfy": { loadBalancer: { servers: [{ url: `http://127.0.0.1:${NTFY_PORT}` }] } } },
  } });
}
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
export function buildNtfyInstallScript(image: string, config: string, ingress: string, enabled: boolean, memoryMb = 128, cpuLimit = 0.5): string {
  if (enabled && !/^docker\.io\/binwiederhier\/ntfy@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("ntfy requires the official immutable image");
  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 4096 || !Number.isFinite(cpuLimit) || cpuLimit < 0.1 || cpuLimit > 4) throw new Error("Invalid ntfy resource limits");
  const root = "/var/lib/ocd/ntfy";
  const fingerprint = ntfyHash(image + config + memoryMb + cpuLimit);
  return `set -eu
umask 077
mkdir -p ${root} /etc/traefik/dynamic
${!enabled ? `rm -f /etc/traefik/dynamic/ntfy.yml
docker stop ${NTFY_CONTAINER} >/dev/null 2>&1 || true
exit 0` : ""}
printf '%s' ${quote(config)} > ${root}/server.yml.next
chmod 600 ${root}/server.yml.next
mv ${root}/server.yml.next ${root}/server.yml
if [ "$(docker inspect --format '{{index .Config.Labels "ocd.ntfy.config"}}' ${NTFY_CONTAINER} 2>/dev/null || true)" != '${fingerprint}' ]; then
  docker pull ${quote(image)} >/dev/null
  docker rm -f ${NTFY_CONTAINER} >/dev/null 2>&1 || true
  docker run -d --name ${NTFY_CONTAINER} --restart unless-stopped --memory ${memoryMb}m --memory-swap ${memoryMb}m --cpus ${cpuLimit} --log-opt max-size=10m --log-opt max-file=3 --label ocd.ntfy.config=${fingerprint} -p 127.0.0.1:${NTFY_PORT}:80 -v ${root}:/var/lib/ntfy -v ${root}/server.yml:/etc/ntfy/server.yml:ro ${quote(image)} serve >/dev/null
else
  docker start ${NTFY_CONTAINER} >/dev/null
fi
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:${NTFY_PORT}/v1/health >/dev/null; then
    printf '%s' ${quote(ingress)} > /etc/traefik/dynamic/ntfy.yml.next
    chmod 644 /etc/traefik/dynamic/ntfy.yml.next
    mv /etc/traefik/dynamic/ntfy.yml.next /etc/traefik/dynamic/ntfy.yml
    exit 0
  fi
  sleep 1
done
exit 1
`;
}
let pending: Promise<void> | undefined;
export function reconcileNtfyService(): Promise<void> {
  // A caller that changed bindings during an in-flight sync must get its own
  // fresh render before starting an app with those credentials.
  const next = (pending ?? Promise.resolve()).catch(() => {}).then(reconcile).catch(error => {
    db.saveSetting("ntfy_status", "error");
    throw error;
  });
  pending = next;
  void next.finally(() => { if (pending === next) pending = undefined; }).catch(() => {});
  return next;
}
async function reconcile(): Promise<void> {
  const settings = ntfySettings();
  if (!settings || recoveryPending()) return;
  const panel = db.getPanel();
  const server = panel && db.getServer(panel.server_id);
  if (!server?.ssh_host_key) throw new Error("ntfy requires a panel server with a pinned SSH host key");
  if (settings.enabled && (settings.domain === panel?.domain || db.getApps().some(a => a.domain === settings.domain))) throw new Error("ntfy domain is already in use");
  const reservation = db.default.query("SELECT id FROM port_reservations WHERE server_id=? AND owner_type='ntfy' AND owner_id='shared'").get(server.id);
  if (settings.enabled && !reservation) db.reserveHostPort({ serverId: server.id, bindAddress: "127.0.0.1", hostPort: NTFY_PORT, ownerType: "ntfy", ownerId: "shared" });
  if (settings.enabled && settings.alerts) await ensureNtfyCredential("system", "events");
  const credentials: Array<NtfyCredential & { token: string; access: string }> = [];
  for (const credential of ntfyCredentials()) {
    let access = "";
    if (credential.owner_type === "system" && settings.alerts) access = "wo";
    if (credential.owner_type === "user" && settings.alerts && db.getUserById(credential.owner_id) && ntfyPreferences(credential.owner_id).enabled) access = "ro";
    if (credential.owner_type === "app" && settings.apps && db.getApp(Number(credential.owner_id))) {
      // Prepared grants stay valid until rollout attestation retires them.
      access = credential.permissions;
    }
    if (access) credentials.push({ ...credential, token: (await credentialSecret(credential)).token, access });
  }
  const config = renderNtfyConfig(settings, credentials);
  let image = db.getSettings().ntfy_image_digest;
  if (!image && settings.enabled) {
    image = await resolveOciImage(NTFY_IMAGE);
    db.saveSetting("ntfy_image_digest", image);
  }
  const fingerprint = ntfyHash(JSON.stringify(settings) + config + image + server.id);
  // Probe on every tick; unchanged config does not restart the process.
  const script = buildNtfyInstallScript(image || "", config, renderNtfyIngress(settings.domain), settings.enabled, settings.memory_mb, settings.cpu_limit);
  const result = await sshExecWithStdin(server.management_address || server.ipv4, server.ssh_user && server.ssh_user !== "root" ? "sudo -n sh -s" : "sh -s", script, server.ssh_host_key, { user: server.ssh_user, port: server.ssh_port });
  if (result.exitCode !== 0) {
    db.saveSetting("ntfy_status", "error");
    throw new Error("ntfy reconciliation failed; inspect the ntfy container on the panel server");
  }
  db.saveSetting("ntfy_status", settings.enabled ? "ready" : "disabled");
  db.saveSetting("ntfy_applied", fingerprint);
  db.saveSetting("ntfy_checked_at", new Date().toISOString());
}
