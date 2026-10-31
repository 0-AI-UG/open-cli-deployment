import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../shared/paths.ts";
import * as db from "../shared/db.ts";
import { BUILD_LOCK, BUILDX_BUILDER } from "./build-worker.ts";
import { parsePlacement } from "../shared/placement.ts";
import { sshExec, sshExecWithStdin } from "../shared/remote/index.ts";
import { assertPrivateCiRepository, assertCiOrganizationGroup, hasQueuedCiJob, CiRepositoryError, ciInstallationToken, githubCiRequest, GitHubCiError } from "./ci-github.ts";

const ROOT = "/opt/ocd-ci";
const SERVICE = "ocd-ci-runner.service";
export const shellQuoteCi = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export function assertCiServerAvailable(serverId: number, sharedBuilds = false): void {
  const server = db.getServer(serverId);
  if (!server || server.status !== "ready") throw new Error("Select a ready server for CI");
  if (db.getPanel()?.server_id === serverId || (!sharedBuilds && db.getBuildWorkerByServerId(serverId)) ||
    db.getApps(serverId).length || db.getApps().some(app => parsePlacement(app.placement)[String(serverId)])) {
    throw new Error("CI requires a server without panel or apps; use --share-builds to reuse an OCD build worker");
  }
  if (sharedBuilds && !db.getBuildWorkerByServerId(serverId)) throw new Error("Shared CI requires an installed OCD build worker");
}
export function ciInstallScript(sharedBuilds = false, jobTimeoutSeconds = 1800): string {
  return `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git jq unzip zip ca-certificates libicu-dev sudo build-essential python3 python3-dev python3-venv pkg-config nodejs npm gh
command -v docker >/dev/null
docker buildx version >/dev/null
id ocd-ci >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ocd-ci
usermod -aG docker ocd-ci
${sharedBuilds ? `usermod -aG deploy ocd-ci
test -d /opt/ocd-build-worker
touch ${BUILD_LOCK}
chown deploy:deploy ${BUILD_LOCK}
chmod 0660 ${BUILD_LOCK}` : ""}
printf '%s\\n' 'ocd-ci ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ocd-ci
chmod 0440 /etc/sudoers.d/ocd-ci
install -d -o ocd-ci -g ocd-ci -m 0755 /opt/hostedtoolcache
install -d -o root -g root -m 0755 ${ROOT}
install -d -o root -g root -m 0700 /var/log/ocd-ci
cat > /etc/systemd/system/${SERVICE} <<'UNIT'
[Unit]
Description=OCD single-job GitHub Actions runner
After=network-online.target docker.service
Wants=network-online.target
[Service]
Type=simple
User=ocd-ci
WorkingDirectory=${ROOT}/run
ExecStart=${sharedBuilds ? `/usr/bin/flock -n -E 75 ${BUILD_LOCK} ` : ""}${ROOT}/run/run.sh
RuntimeMaxSec=${jobTimeoutSeconds + 60}
Restart=no
KillMode=control-group
KillSignal=SIGINT
TimeoutStopSec=30
UMask=0077
Environment=RUNNER_TOOL_CACHE=/opt/hostedtoolcache
Environment=AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload`;
}
type Release = { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] };
let releaseCache: { at: number; value: Release } | undefined;
async function latestRelease(): Promise<Release> {
  if (releaseCache && Date.now() - releaseCache.at < 600_000) return releaseCache.value;
  const release = await githubCiRequest<Release>("/repos/actions/runner/releases/latest", "");
  releaseCache = { at: Date.now(), value: release };
  return release;
}
export function ciPackageScript(release: Release): { version: string; script: string } {
  const version = release.tag_name.replace(/^v/, "");
  if (!/^2\.\d+\.\d+$/.test(version)) throw new Error("Invalid GitHub runner release version");
  const filename = `actions-runner-linux-x64-${version}.tar.gz`;
  const asset = release.assets.find(asset => asset.name === filename);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "") || asset.browser_download_url !== `https://github.com/actions/runner/releases/download/v${version}/${filename}`) {
    throw new Error("GitHub runner release is missing a verified Linux x64 asset");
  }
  return { version, script: `set -eu
test "$(uname -m)" = x86_64
if [ -d ${ROOT}/run/_diag ]; then
  tar -czf /var/log/ocd-ci/diag-$(date +%s).tar.gz -C ${ROOT}/run _diag
  ls -1t /var/log/ocd-ci/diag-*.tar.gz | tail -n +11 | xargs -r rm -f
fi
rm -rf ${ROOT}/run
install -d -o ocd-ci -g ocd-ci -m 0700 ${ROOT}/run
if [ ! -f ${ROOT}/${filename} ]; then
  curl --fail --location --proto '=https' --tlsv1.2 ${shellQuoteCi(asset.browser_download_url)} -o ${ROOT}/download.tmp
  printf '%s  %s\\n' ${shellQuoteCi(asset.digest!.slice(7))} ${ROOT}/download.tmp | sha256sum -c - >/dev/null
  rm -f ${ROOT}/actions-runner-*.tar.gz
  mv ${ROOT}/download.tmp ${ROOT}/${filename}
fi
printf '%s  %s\\n' ${shellQuoteCi(asset.digest!.slice(7))} ${ROOT}/${filename} | sha256sum -c - >/dev/null
tar -xzf ${ROOT}/${filename} -C ${ROOT}/run
chown -R ocd-ci:ocd-ci ${ROOT}/run
${ROOT}/run/bin/installdependencies.sh >/dev/null` };
}

/** Keep diagnostics on the panel before the single-job directory is replaced. */
export async function preserveCiDiagnostics(runner: db.CiRunnerRow): Promise<void> {
  const server = db.getServer(runner.server_id);
  if (!server) throw new Error("CI server disappeared");
  const archive = await sshExec(server.ipv4,
    `set -eu; if [ -d ${ROOT}/run/_diag ]; then tar -czf ${ROOT}/diagnostics.tar.gz -C ${ROOT}/run _diag; base64 -w0 ${ROOT}/diagnostics.tar.gz; rm -f ${ROOT}/diagnostics.tar.gz; fi`,
    server.ssh_host_key || undefined);
  if (archive.exitCode !== 0) throw new Error("Could not preserve CI runner diagnostics");
  if (!archive.stdout.trim()) return;
  const directory = path.join(DATA_DIR, "ci-logs", String(runner.id));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `${Date.now()}.tar.gz`), Buffer.from(archive.stdout.trim(), "base64"), { mode: 0o600 });
  const files = (await readdir(directory)).filter(name => /^\d+\.tar\.gz$/.test(name)).sort().reverse();
  for (const file of files.slice(10)) await unlink(path.join(directory, file));
}

export function ciCleanupScript(sharedBuilds: boolean): string {
  return `set -eu
for id in $(docker ps -aq); do
  name=$(docker inspect --format '{{.Name}}' "$id")
  ${sharedBuilds ? `[ "$name" = /buildx_buildkit_${BUILDX_BUILDER}0 ] && continue` : ":"}
  docker rm -f "$id" >/dev/null
done
docker network prune -f >/dev/null
docker volume prune -f >/dev/null
if [ "$(df -B1 --output=avail / | tail -1)" -lt 16106127360 ]; then
  docker image prune -af >/dev/null
  docker builder prune -af --keep-storage 4GB >/dev/null
fi
if [ -d /home/ocd-ci ]; then find /home/ocd-ci -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; fi`;
}
function exclusiveCiCommand(script: string, shared: boolean): string {
  return shared ? `flock -n -E 75 ${shellQuoteCi(BUILD_LOCK)} sh -c ${shellQuoteCi(script)}` : script;
}
/** Release only after the service has exited and host cleanup/BuildKit recovery succeeded. */
export async function releaseCiHost(runner: db.CiRunnerRow): Promise<void> {
  if (!runner.host_reserved) return;
  const server = db.getServer(runner.server_id);
  if (!server) throw new Error("CI server disappeared");
  await preserveCiDiagnostics(runner);
  const restore = runner.shared_builds ? `
runuser -u deploy -- docker buildx inspect ${BUILDX_BUILDER} --bootstrap >/dev/null
if [ "$(df -B1 --output=avail / | tail -1)" -lt 16106127360 ]; then
  runuser -u deploy -- docker buildx prune --builder ${BUILDX_BUILDER} -af --keep-storage 4GB >/dev/null
fi` : "";
  const result = await sshExec(server.ipv4, exclusiveCiCommand(`set -eu
state=$(systemctl show ${SERVICE} --property=ActiveState --value 2>/dev/null || true)
case "$state" in active|activating|deactivating) exit 73 ;; esac
` + ciCleanupScript(!!runner.shared_builds) + restore, !!runner.shared_builds), server.ssh_host_key || undefined);
  if (result.exitCode !== 0) throw new Error("CI cleanup or BuildKit recovery failed; host remains reserved");
  db.updateCiRunner(runner.id, { host_reserved: 0, registered_at: null });
}

/** All execution-changing calls are serialized by durable CI operations. */
async function reconcileCiRunner(id: number, observeOnly: boolean): Promise<boolean> {
  let runner = db.getCiRunner(id);
  if (!runner) return false;
  const server = db.getServer(runner.server_id);
  if (!server) throw new Error("CI server disappeared");
  const exec = (script: string) => sshExec(server.ipv4, script, server.ssh_host_key || undefined);
  const token = await ciInstallationToken(runner.repository, undefined, runner.scope);
  const base = `/${runner.scope === "organization" ? "orgs" : "repos"}/${runner.repository}/actions/runners`;
  let registered: { id: number; busy: boolean; status: string } | null = null;
  if (runner.github_runner_id) {
    try { registered = await githubCiRequest(`${base}/${runner.github_runner_id}`, token); }
    catch (error) { if (!(error instanceof GitHubCiError && error.status === 404)) throw error; }
  }
  if (!registered) {
    const result = await githubCiRequest<{ runners: { id: number; name: string; busy: boolean; status: string }[] }>(`${base}?name=${encodeURIComponent(runner.github_name)}&per_page=100`, token);
    registered = result.runners.find(item => item.name === runner!.github_name) ?? null;
    if (registered) db.updateCiRunner(id, { github_runner_id: registered.id });
  }
  const observed = await exec(`if [ -f /etc/systemd/system/${SERVICE} ]; then systemctl show ${SERVICE} --property=ActiveState --value; else echo inactive; fi`);
  if (observed.exitCode !== 0) throw new Error("Could not inspect CI runner service");
  const active = ["active", "activating", "deactivating"].includes(observed.stdout.trim());
  const idleExpired = runner.shared_builds && runner.registered_at && Date.now() - Date.parse(runner.registered_at) > 60_000;
  const yieldToBuild = runner.shared_builds && db.hasBuildCapacityWaiters();
  if (runner.draining || (active && !registered?.busy && (idleExpired || yieldToBuild))) {
    if (registered?.busy) {
      db.updateCiRunner(id, { status: "draining", last_error: "", last_checked_at: new Date().toISOString() });
      return false;
    }
    if (observeOnly) return true;
    // A job assigned since the busy check makes GitHub reject deletion. Never stop it then.
    if (registered) await githubCiRequest(`${base}/${registered.id}`, token, "DELETE");
    const stopped = await exec(`if [ -f /etc/systemd/system/${SERVICE} ]; then systemctl stop ${SERVICE}; fi`);
    if (stopped.exitCode !== 0) throw new Error("Could not stop CI runner service");
    await releaseCiHost(runner);
    db.updateCiRunner(id, { status: runner.draining ? "drained" : "idle", github_runner_id: null, last_error: "", last_checked_at: new Date().toISOString() });
    return false;
  }
  let repositories = [runner.repository];
  try {
    if (runner.scope === "organization") {
      const group = await assertCiOrganizationGroup(runner.repository, runner.runner_group_id!, token);
      if (group.name !== runner.runner_group_name) throw new CiRepositoryError("Configured CI runner group was renamed; restore its name before resuming");
      repositories = group.repositories;
    } else await assertPrivateCiRepository(runner.repository, token);
  } catch (error) {
    if (error instanceof CiRepositoryError) db.updateCiRunner(id, { draining: 1, status: "draining" });
    throw error;
  }
  if (active) {
    if (runner.shared_builds && !runner.host_reserved) throw new Error("Shared CI service has no reservation; refusing to admit more work");
    db.updateCiRunner(id, { status: registered?.busy ? "busy" : registered?.status === "online" ? "online" : "starting", last_error: "", last_checked_at: new Date().toISOString() });
    return false;
  }
  if (registered?.busy) throw new Error("GitHub still reports a job on an inactive runner; waiting for reconciliation");
  if (runner.host_reserved) {
    if (observeOnly) return true;
    if (registered) await githubCiRequest(`${base}/${registered.id}`, token, "DELETE");
    await releaseCiHost(runner);
    db.updateCiRunner(id, { github_runner_id: null, status: "idle" });
    return false;
  }
  if (runner.shared_builds && (db.hasBuildCapacityWaiters() || !await hasQueuedCiJob(repositories, token))) {
    db.updateCiRunner(id, { status: "idle", last_error: "", last_checked_at: new Date().toISOString() });
    return false;
  }
  if (observeOnly) return true;
  if (!db.tryReserveCiHost(id)) {
    db.updateCiRunner(id, { status: "waiting_for_build", last_error: "", last_checked_at: new Date().toISOString() });
    return false;
  }
  runner = db.getCiRunner(id)!;
  if (registered) await githubCiRequest(`${base}/${registered.id}`, token, "DELETE");
  db.updateCiRunner(id, { github_runner_id: null, status: "starting" });
  const pkg = ciPackageScript(await latestRelease());
  await preserveCiDiagnostics(runner);
  const stopBuilder = runner.shared_builds ? `runuser -u deploy -- docker buildx stop ${BUILDX_BUILDER} >/dev/null\n` : "";
  const prepared = await exec(exclusiveCiCommand("set -eu\n" + stopBuilder + ciCleanupScript(!!runner.shared_builds) + "\n" + pkg.script, !!runner.shared_builds));
  if (prepared.exitCode !== 0) throw new Error("Could not prepare CI runner; host remains reserved for safe recovery");
  const registration = await githubCiRequest<{ token: string }>(`${base}/registration-token`, token, "POST");
  if (!/^[A-Za-z0-9_-]+$/.test(registration.token)) throw new Error("Invalid runner registration token");
  // Persist the idle deadline before starting: a crash must not strand the host.
  db.updateCiRunner(id, { registered_at: new Date().toISOString() });
  const configured = await sshExecWithStdin(server.ipv4, `set -eu
read -r token
cd ${ROOT}/run
runuser -u ocd-ci -- ./config.sh --unattended --ephemeral --url ${shellQuoteCi(`https://github.com/${runner.repository}`)} --name ${shellQuoteCi(runner.github_name)} --labels ocd-ci ${runner.scope === "organization" ? `--runnergroup ${shellQuoteCi(runner.runner_group_name)} ` : ""}--work _work --token "$token" >/dev/null 2>&1
systemctl reset-failed ${SERVICE} || true
systemctl start ${SERVICE}`, `${registration.token}\n`, server.ssh_host_key || undefined);
  if (configured.exitCode !== 0) throw new Error("Could not configure or start CI runner; host remains reserved for recovery");
  db.updateCiRunner(id, { status: "starting", runner_version: pkg.version, last_error: "", last_checked_at: new Date().toISOString() });
  return false;
}
export async function syncCiRunner(id: number): Promise<void> { await reconcileCiRunner(id, false); }
export async function observeCiRunner(id: number): Promise<boolean> { return reconcileCiRunner(id, true); }

export async function removeCiRunnerFiles(id: number): Promise<void> {
  const runner = db.getCiRunner(id);
  if (!runner) return;
  if (runner.status !== "drained") throw new Error("Drain the CI runner and wait for its job to finish before removal");
  const server = db.getServer(runner.server_id);
  if (!server) throw new Error("CI server disappeared");
  await preserveCiDiagnostics(runner);
  const result = await sshExec(server.ipv4, `set -eu
if [ -f /etc/systemd/system/${SERVICE} ]; then systemctl stop ${SERVICE}; fi
rm -f /etc/systemd/system/${SERVICE} /etc/sudoers.d/ocd-ci
systemctl daemon-reload
rm -rf ${ROOT}
userdel -r ocd-ci 2>/dev/null || true`, server.ssh_host_key || undefined);
  if (result.exitCode !== 0) throw new Error("Could not remove CI runner files");
  db.deleteCiRunner(id);
}
