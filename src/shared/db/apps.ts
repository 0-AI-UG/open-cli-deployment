import { affectedAppsForEnvironmentKeys } from "../runtime-env.ts";
import db from "./connection.ts";
import type { ServerRow } from "./servers.ts";
import type { ReplicaRow } from "./replicas.ts";
import { serializePlacement, type Placement } from "../placement.ts";

const IMMUTABLE_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i;

function assertImmutableImageRef(imageRef: string): void {
  if (!IMMUTABLE_IMAGE.test(imageRef)) {
    throw new Error("image_ref must be an immutable OCI reference ending in @sha256:<64 hex digest>");
  }
}

export type AppRow = {
  id: number;
  name: string;
  domain: string;
  image_ref: string;
  build_source_id: number | null;
  build_repository: string;
  build_branch: string;
  build_dockerfile: string;
  build_context: string;
  build_image: string;
  container_port: number;
  env_vars: string;
  status: string;
  deploy_log: string;
  created_at: string;
  volume_id: string;
  volume_mount: string;
  volume_driver: string;
  /** 0 = volume was CREATED by us (deleted on destroy); 1 = an EXISTING volume
   *  ATTACHED via attach_existing_volume (detached-not-deleted on destroy). */
  volume_attached: number;
  /** Manifest-owned primary-volume intent. desired_volume_id empty means OCD
   * creates the volume; desired_volume_size 0 means explicitly no volume.
   * A negative size is a migration-only legacy sentinel awaiting a manifest. */
  desired_volume_id: string;
  desired_volume_size: number;
  desired_volume_path: string;
  desired_volume_driver: string;
  /** Declared placement JSON: server id (string) -> replica count. NULL until
   *  the app's first deploy records it. */
  placement: string | null;
  deployed_by: string;
  environment_id: number | null;
  /** 1 when the linked environment changed since the running containers were
   * created. A plain pause/unpause does not clear it; deploy/redeploy/reload do. */
  environment_stale: number;
  stack_id: number | null;
  /** JSON array of the member keys this stack member depends on, as declared by
   *  `needs` in the stack manifest. NULL for non-members and for members
   *  deployed before migration 84 — treat NULL as "no known edges". */
  stack_needs: string | null;
  public: number;
  public_endpoint_status: string;
  public_endpoint_error: string;
  public_endpoint_checked_at: string | null;
  memory_mb: number; // per-container memory ceiling in MB; 0 = platform default
  cpu_limit: number; // per-container CPU ceiling in cores (fractional allowed); 0 = platform default
  command_json: string;
  cap_add_json: string;
  health_check: number; // 1 = HTTP probe (default); 0 = only verify the container is running
  health_check_mode: string;
  health_check_command: string;
  health_check_file: string;
  health_check_max_age_seconds: number;
  /** JSON array of exact HTTP readiness status codes. */
  health_check_expected_statuses: string;
  /** Internal routing protocol on the app's internal entrypoint: 'http' =
   *  Traefik HTTP router (L7), 'tcp' = raw TCP pass-through. Decoupled from
   *  health_check (which only controls the container probe) — see migration 67. */
  internal_protocol: string; // 'http' | 'tcp'
  internal_port: number; // fleet-unique internal ingress port (20000-20199), owned for the app's lifetime
  virtual_ip: string; // fleet-unique per-app VIP in 10.96.0.0/16, owned for the app's lifetime
  rate_limit_rps: number; // public-router rate limit in req/s; 0 = unlimited
  health_check_path: string; // active HTTP health-check path (e.g. /healthz); "" = off
  compress: number; // 1 = gzip/brotli compression on the public router
  /** Monotonic desired-configuration revision. It changes independently of
   * source commits and is captured by every successful deployment. */
  config_revision: number;
  last_manifest_path: string | null;
  last_manifest_hash: string | null;
  last_manifest_applied_at: string | null;
  last_manifest_config_revision: number | null;
  manifest_path: string | null;
  stack_manifest_path: string | null;
  rollout_requested_revision: number;
  rollout_requested_after_deployment_id: number;
  deletion_requested_at: string | null;
};

/** Internal ingress port block: every app owns one port in
 *  [INTERNAL_PORT_BASE, INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT).
 *  The block size doubles as the hard fleet app cap. */
export const INTERNAL_PORT_BASE = 20000;
export const INTERNAL_PORT_COUNT = 200;

/** Per-app virtual IP block: every app owns one address in this range.
 *  Disjoint from ocd-net (10.0.0.0/16) and the Docker bridge (172.17.0.0/16). */
export const VIP_RANGE = "10.96.0.0/16";

/** Dotted quad for the nth address in VIP_RANGE. Valid indexes are 1-65534:
 *  0 is the network address, 65535 the broadcast address. */
export function vipFromIndex(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > 65534) {
    throw new Error(`VIP index ${index} out of range (1-65534)`);
  }
  return `10.96.${Math.floor(index / 256)}.${index % 256}`;
}

/** Internal routing protocol on the app's internal entrypoint. */
export type InternalProtocol = "http" | "tcp";

export function countApps(): number {
  const row = db.query("SELECT COUNT(*) as c FROM apps").get() as { c: number } | null;
  return row?.c ?? 0;
}

/** Lowest free port in the internal block. The partial unique index on
 *  apps.internal_port is the concurrency backstop; deleting an app row frees
 *  its port automatically. Ports are never reallocated on redeploy/move/scale
 *  because they live on the app row. */
export function allocateInternalPort(): number {
  const used = new Set(
    (db.query("SELECT internal_port FROM apps WHERE internal_port > 0").all() as Array<{ internal_port: number }>)
      .map((r) => r.internal_port),
  );
  for (let port = INTERNAL_PORT_BASE; port < INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error(
    `Fleet limit of ${INTERNAL_PORT_COUNT} apps reached (internal port block ${INTERNAL_PORT_BASE}-${INTERNAL_PORT_BASE + INTERNAL_PORT_COUNT - 1} is full). Destroy an app before deploying a new one.`,
  );
}

/** Lowest free address in the VIP block. Mirrors allocateInternalPort: the
 *  partial unique index on apps.virtual_ip is the concurrency backstop;
 *  deleting an app row frees its VIP automatically. VIPs are never
 *  reallocated on redeploy/move/scale because they live on the app row. */
export function allocateVirtualIp(): string {
  const used = new Set(
    (db.query("SELECT virtual_ip FROM apps WHERE virtual_ip != ''").all() as Array<{ virtual_ip: string }>)
      .map((r) => {
        const [, , c, d] = r.virtual_ip.split(".").map(Number);
        return c * 256 + d;
      }),
  );
  for (let index = 1; index <= 65534; index++) {
    if (!used.has(index)) return vipFromIndex(index);
  }
  throw new Error(`Virtual IP range ${VIP_RANGE} is exhausted. Destroy an app before deploying a new one.`);
}

export function getApps(serverId?: number): AppRow[] {
  if (serverId) {
    return db
      .query(
        "SELECT DISTINCT a.* FROM apps a JOIN replicas r ON r.app_id = a.id WHERE r.server_id = ? ORDER BY a.created_at DESC"
      )
      .all(serverId) as AppRow[];
  }
  return db
    .query("SELECT * FROM apps ORDER BY created_at DESC")
    .all() as AppRow[];
}

export function getApp(id: number): AppRow | null {
  return db.query("SELECT * FROM apps WHERE id = ?").get(id) as AppRow | null;
}

export function getAppByName(name: string): AppRow | null {
  return db.query("SELECT * FROM apps WHERE name = ?").get(name) as AppRow | null;
}

export function getAppByDomain(domain: string): AppRow | null {
  return db
    .query("SELECT * FROM apps WHERE domain = ? LIMIT 1")
    .get(domain) as AppRow | null;
}

export function updateAppBuildConfig(id: number, input: {
  sourceId: number;
  repository: string;
  branch: string;
  dockerfile: string;
  context: string;
  imageRepository: string;
}): void {
  db.query(
    `UPDATE apps SET build_source_id = ?, build_repository = ?, build_branch = ?,
       build_dockerfile = ?, build_context = ?, build_image = ? WHERE id = ?`,
  ).run(
    input.sourceId,
    input.repository,
    input.branch,
    input.dockerfile,
    input.context,
    input.imageRepository,
    id,
  );
}

/** Detach an app from source-build delivery and remove the now-orphaned source.
 * Returns the deleted source id so callers can remove its external secret. */
export function clearAppBuildConfig(id: number): number | null {
  return db.transaction(() => {
    const app = getApp(id);
    const sourceId = app?.build_source_id ?? null;
    db.query(
      `UPDATE apps SET build_source_id = NULL, build_repository = '', build_branch = 'main',
       build_dockerfile = 'Dockerfile', build_context = '.', build_image = '' WHERE id = ?`,
    ).run(id);
    if (sourceId == null) return null;
    const remaining = db.query("SELECT COUNT(*) AS count FROM apps WHERE build_source_id = ?")
      .get(sourceId) as { count: number };
    if (remaining.count > 0) return null;
    db.query("DELETE FROM build_sources WHERE id = ?").run(sourceId);
    return sourceId;
  })();
}

export type AppIngressSettings = {
  rate_limit_rps?: number;
  health_check_path?: string;
  compress?: boolean;
  /** Post-deploy HTTP probe on/off. Applies on the app's next (re)deploy or
   *  scale — unlike the rest of these, it isn't a live Traefik-config change. */
  health_check?: boolean;
  health_check_mode?: "http" | "container" | "exec" | "heartbeat";
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  health_check_expected_statuses?: number[];
};

type InsertAppFields = {
  name: string;
  domain: string;
  image_ref: string;
  container_port: number;
  env_vars: string;
  environment_id?: number;
  public?: boolean;
  health_check?: boolean;
  /** Internal routing protocol. Omitted → derived from health_check (http when
   *  health_check is on, tcp when off) so callers that only set health_check
   *  keep the historical routing coupling. */
  internal_protocol?: InternalProtocol;
  /** Resolved placement (server id -> replica count). */
  placement?: Placement;
  desired_volume_id?: string;
  desired_volume_size?: number;
  desired_volume_path?: string;
  desired_volume_driver?: string;
  command?: string[];
  cap_add?: string[];
} & AppIngressSettings;

// The single apps-table INSERT, shared by insertApp and
// insertAppWithFirstReplica (which wrap it in their own transactions —
// insertAppWithFirstReplica additionally inserts the first replica in the same
// tx). allocateInternalPort/allocateVirtualIp run here so both paths allocate
// identically.
function insertAppRow(app: InsertAppFields): AppRow {
  assertImmutableImageRef(app.image_ref);
  const healthCheck = app.health_check_mode
    ? app.health_check_mode === "http"
    : (app.health_check ?? true);
  // Internal routing protocol is an explicit, first-class field (independent of
  // health_check): use the caller's value or default to "http". Raw-TCP apps
  // (e.g. databases) must set internal_protocol: "tcp" explicitly.
  const internalProtocol: InternalProtocol = app.internal_protocol ?? "http";
  return db
    .query(
      "INSERT INTO apps (name, domain, image_ref, container_port, env_vars, environment_id, public, health_check, health_check_mode, health_check_command, health_check_file, health_check_max_age_seconds, health_check_expected_statuses, internal_protocol, internal_port, virtual_ip, rate_limit_rps, health_check_path, compress, placement, desired_volume_id, desired_volume_size, desired_volume_path, desired_volume_driver, command_json, cap_add_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(
      app.name,
      app.domain,
      app.image_ref,
      app.container_port,
      app.env_vars,
      app.environment_id ?? null,
      (app.public ?? true) ? 1 : 0,
      healthCheck ? 1 : 0,
      app.health_check_mode ?? (healthCheck ? "http" : "container"),
      app.health_check_command ?? "",
      app.health_check_file ?? "",
      app.health_check_max_age_seconds ?? 0,
      JSON.stringify(app.health_check_expected_statuses ?? [200]),
      internalProtocol,
      allocateInternalPort(),
      allocateVirtualIp(),
      app.rate_limit_rps ?? 0,
      app.health_check_path ?? "",
      app.compress ? 1 : 0,
      app.placement ? serializePlacement(app.placement) : null,
      app.desired_volume_id ?? "",
      app.desired_volume_size ?? 0,
      app.desired_volume_path ?? "/data",
      app.desired_volume_driver ?? "",
      JSON.stringify(app.command ?? []),
      JSON.stringify(app.cap_add ?? []),
    ) as AppRow;
}

export function insertApp(app: InsertAppFields): AppRow {
  const tx = db.transaction(() => insertAppRow(app));
  return tx();
}

export function insertAppWithFirstReplica(
  app: InsertAppFields,
  serverId: number,
): { app: AppRow; replica: ReplicaRow } {
  const tx = db.transaction(() => {
    const appRow = insertAppRow(app);
    const hostPort = nextReplicaHostPort(serverId);
    const replicaRow = db
      .query(
        "INSERT INTO replicas (app_id, server_id, host_port, container_name, status) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(appRow.id, serverId, hostPort, app.name, "deploying") as ReplicaRow;
    return { app: appRow, replica: replicaRow };
  });
  return tx();
}

export function getServersForApp(appId: number): ServerRow[] {
  return db
    .query(
      "SELECT DISTINCT s.* FROM servers s JOIN replicas r ON r.server_id = s.id WHERE r.app_id = ? ORDER BY s.id ASC",
    )
    .all(appId) as ServerRow[];
}

export function updateAppStatus(id: number, status: string): void {
  db.query("UPDATE apps SET status = ? WHERE id = ?").run(status, id);
}

export function requestAppRollout(id: number, revision?: number): void {
  db.query(
    `UPDATE apps SET
       rollout_requested_revision = COALESCE(?, config_revision),
       rollout_requested_after_deployment_id = COALESCE(
         (SELECT MAX(id) FROM deployment_history WHERE app_id = apps.id),
         0
       )
     WHERE id = ?`,
  ).run(revision ?? null, id);
}

export function clearAppRolloutRequest(id: number, throughRevision: number): void {
  db.query(
    `UPDATE apps SET
       rollout_requested_revision = 0,
       rollout_requested_after_deployment_id = 0
     WHERE id = ? AND rollout_requested_revision <= ?`,
  ).run(id, throughRevision);
}

export function markAppDeletionRequested(id: number): void {
  db.query(
    "UPDATE apps SET deletion_requested_at = COALESCE(deletion_requested_at, datetime('now')), status = 'destroying' WHERE id = ?",
  ).run(id);
}

export function updateAppPublicEndpointStatus(id: number, status: string, error = ""): void {
  db.query(
    "UPDATE apps SET public_endpoint_status = ?, public_endpoint_error = ?, public_endpoint_checked_at = datetime('now') WHERE id = ?",
  ).run(status, error, id);
}

export function updateAppDeployedBy(id: number, userId: string): void {
  db.query("UPDATE apps SET deployed_by = ? WHERE id = ?").run(userId, id);
}

export function appendDeployLog(id: number, line: string): void {
  db.query(
    "UPDATE apps SET deploy_log = deploy_log || ? WHERE id = ?"
  ).run(line + "\n", id);
}

export function getDeployLog(id: number): string {
  const row = db
    .query("SELECT deploy_log FROM apps WHERE id = ?")
    .get(id) as { deploy_log: string } | null;
  return row?.deploy_log ?? "";
}

export function deleteApp(id: number): void {
  db.query("DELETE FROM apps WHERE id = ?").run(id);
}

export function updateAppEnvVars(id: number, envVars: string): void {
  db.query(`UPDATE apps SET env_vars = ?, config_revision = config_revision + 1,
    rollout_requested_revision = CASE WHEN rollout_requested_revision > 0 THEN config_revision + 1 ELSE 0 END
    WHERE id = ? AND env_vars <> ?`).run(envVars, id, envVars);
}

export function getAppsByEnvironmentId(environmentId: number): AppRow[] {
  return db.query("SELECT * FROM apps WHERE environment_id = ?").all(environmentId) as AppRow[];
}

export function updateAppEnvironment(id: number, environmentId: number | null): void {
  db.query("UPDATE apps SET environment_id = ? WHERE id = ?").run(environmentId, id);
}

export function markAppsEnvironmentStale(environmentId: number): number {
  const result = db.query(
    "UPDATE apps SET environment_stale = 1 WHERE environment_id = ? AND status NOT IN ('destroying','cleanup_failed')",
  ).run(environmentId);
  return result.changes;
}

export function markAppsEnvironmentStaleForKeys(environmentId: number, changedKeys: string[]): number {
  if (changedKeys.length === 0) return 0;
  let count = 0;
  for (const app of getAppsAffectedByEnvironment(environmentId, changedKeys)) {
    const result = db.query(
      "UPDATE apps SET environment_stale = 1 WHERE id = ? AND status NOT IN ('destroying','cleanup_failed')",
    ).run(app.id);
    count += result.changes;
  }
  return count;
}

export function markAppEnvironmentFresh(id: number): void {
  db.query("UPDATE apps SET environment_stale = 0 WHERE id = ?").run(id);
}

export function getAppsAffectedByEnvironment(environmentId: number, changedKeys?: string[]): AppRow[] {
  const stacks = db.query("SELECT id, name FROM stacks").all() as {id:number;name:string}[];
  const keys = changedKeys ?? (() => {
    const row = db.query("SELECT env_vars FROM environments WHERE id = ?").get(environmentId) as {env_vars:string} | null;
    return row ? (JSON.parse(row.env_vars).entries ?? []).map((entry: {key:string}) => entry.key) : [];
  })();
  return affectedAppsForEnvironmentKeys(getApps(), environmentId, keys, Object.fromEntries(stacks.map((s) => [s.id,s.name])));
}

export function updateAppContainerPort(id: number, port: number): void {
  db.query("UPDATE apps SET container_port = ? WHERE id = ?").run(port, id);
}

export function updateAppArtifactAndHealth(
  id: number,
  fields: {
    imageRef: string;
    healthMode: string;
    healthCommand: string;
    healthFile: string;
    healthMaxAgeSeconds: number;
    healthExpectedStatuses?: number[];
  },
): void {
  assertImmutableImageRef(fields.imageRef);
  db.query(
    `UPDATE apps SET image_ref = ?, health_check_mode = ?, health_check_command = ?, health_check_file = ?,
       health_check_max_age_seconds = ?, health_check_expected_statuses = ? WHERE id = ?`,
  ).run(
    fields.imageRef,
    fields.healthMode,
    fields.healthCommand,
    fields.healthFile,
    fields.healthMaxAgeSeconds,
    JSON.stringify(fields.healthExpectedStatuses ?? [200]),
    id,
  );
}

/** Commit one externally-published immutable artifact as desired state. */
export function updateAppImageRef(id: number, imageRef: string): void {
  assertImmutableImageRef(imageRef);
  db.query("UPDATE apps SET image_ref = ? WHERE id = ?")
    .run(imageRef, id);
}

/** Record provenance after an explicit manifest apply. This metadata is not
 * itself runtime configuration and therefore does not bump config_revision. */
export function recordAppManifestApplied(id: number, path: string, hash: string): void {
  db.query(
    "UPDATE apps SET manifest_path = ?, last_manifest_path = ?, last_manifest_hash = ?, last_manifest_applied_at = datetime('now'), last_manifest_config_revision = config_revision WHERE id = ?",
  ).run(path, path, hash, id);
}

export function updateAppStackManifestPath(id: number, path: string | null): void {
  db.query("UPDATE apps SET stack_manifest_path = ? WHERE id = ?").run(path, id);
}

/** Collapse the many column-level trigger bumps produced by one manifest
 * transaction into one externally-visible configuration revision. */
export function normalizeAppConfigRevision(id: number, baseRevision: number, force = false): void {
  const current = getApp(id);
  if (!current || (!force && current.config_revision <= baseRevision)) return;
  db.query(
    `UPDATE apps SET config_revision = ?,
       rollout_requested_revision = CASE WHEN rollout_requested_revision > 0 THEN ? ELSE 0 END
     WHERE id = ?`,
  ).run(baseRevision + 1, baseRevision + 1, id);
}

export function updateAppDomain(id: number, domain: string): void {
  db.query("UPDATE apps SET domain = ? WHERE id = ?").run(domain, id);
}

/** Persist an app's volume pointer. `attached` records provenance: false (the
 *  default) = a volume we CREATED (deleted on destroy); true = an EXISTING volume
 *  ATTACHED via attach_existing_volume (detached-not-deleted on destroy). Callers
 *  that CLEAR the volume (empty ids) leave attached at its harmless default. */
export function updateAppVolume(
  id: number,
  volumeId: string,
  volumeMount: string,
  attached = false,
  driverId = "",
): void {
  db.query("UPDATE apps SET volume_id = ?, volume_mount = ?, volume_attached = ?, volume_driver = ? WHERE id = ?")
    .run(volumeId, volumeMount, attached ? 1 : 0, volumeId ? driverId : "", id);
}

export function updateAppDesiredVolume(
  id: number,
  desired: { volumeId: string; sizeGb: number; mountPath: string; driverId?: string },
): void {
  db.query(
    "UPDATE apps SET desired_volume_id = ?, desired_volume_size = ?, desired_volume_path = ?, desired_volume_driver = ? WHERE id = ?",
  ).run(desired.volumeId, desired.sizeGb, desired.mountPath, desired.driverId ?? "", id);
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function parseAppCommand(app: Pick<AppRow, "command_json">): string[] {
  return parseStringArray(app.command_json);
}

export function parseAppCapabilities(app: Pick<AppRow, "cap_add_json">): string[] {
  return parseStringArray(app.cap_add_json);
}

export function updateAppRuntimeOptions(
  id: number,
  options: { command: string[]; capAdd: string[] },
): void {
  db.query("UPDATE apps SET command_json = ?, cap_add_json = ? WHERE id = ?")
    .run(JSON.stringify(options.command), JSON.stringify(options.capAdd), id);
}

/** Set the per-app memory ceiling in MB. 0 = use the platform default. Applied
 *  to the container on the next (re)deploy / scale operation. */
export function updateAppMemory(id: number, memoryMb: number): void {
  db.query("UPDATE apps SET memory_mb = ? WHERE id = ?").run(memoryMb, id);
}

/** Set the per-app CPU ceiling in cores (fractional allowed). 0 = use the
 *  platform default. Applied to the container on the next (re)deploy / scale. */
export function updateAppCpu(id: number, cpuLimit: number): void {
  db.query("UPDATE apps SET cpu_limit = ? WHERE id = ?").run(cpuLimit, id);
}

export function updateAppPublic(id: number, isPublic: boolean): void {
  db.query("UPDATE apps SET public = ? WHERE id = ?").run(isPublic ? 1 : 0, id);
}

/** Set the internal routing protocol ('http' | 'tcp'). Pure Traefik-config
 *  change for the routing itself; the app's OCD_INTERNAL_URL scheme only
 *  refreshes on its next (re)deploy. Callers re-sync ingress after persisting. */
export function updateAppInternalProtocol(id: number, protocol: InternalProtocol): void {
  db.query("UPDATE apps SET internal_protocol = ? WHERE id = ?").run(protocol, id);
}

/** Persist the user-declared placement. Convergence makes reality match. */
export function updateAppPlacement(id: number, placement: Placement): void {
  db.query("UPDATE apps SET placement = ? WHERE id = ?").run(serializePlacement(placement), id);
}

/** Persist a stack member's `needs` edges (member keys from the manifest), or
 *  clear them with `needs = null`. Written by deploy_stack alongside
 *  setAppStack; read by stack-wide ops that must act in dependency order. */
export function setAppStackNeeds(appId: number, needs: string[] | null): void {
  const json = needs && needs.length > 0 ? JSON.stringify(needs) : null;
  db.query("UPDATE apps SET stack_needs = ? WHERE id = ?").run(json, appId);
}

/** Parsed `stack_needs` for an app row — [] when unset, malformed, or the app
 *  predates migration 84. Never throws: ordering degrades to "no edges". */
export function parseStackNeeds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch { return []; }
}

/** Partial update of the per-app ingress settings (rate limit, health-check
 *  path, compression). Values are rendered
 *  into Traefik dynamic config — callers re-sync ingress after persisting. */
export function updateAppIngressSettings(id: number, fields: AppIngressSettings): void {
  const sets: string[] = [];
  const values: (string | number)[] = [];
  if (fields.rate_limit_rps !== undefined) { sets.push("rate_limit_rps = ?"); values.push(fields.rate_limit_rps); }
  if (fields.health_check_path !== undefined) { sets.push("health_check_path = ?"); values.push(fields.health_check_path); }
  if (fields.compress !== undefined) { sets.push("compress = ?"); values.push(fields.compress ? 1 : 0); }
  if (fields.health_check !== undefined) { sets.push("health_check = ?"); values.push(fields.health_check ? 1 : 0); }
  if (sets.length === 0) return;
  values.push(id);
  db.query(`UPDATE apps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function nextReplicaHostPort(serverId: number): number {
  const BASE_PORT = 10000;
  const row = db
    .query("SELECT MAX(host_port) as max_port FROM replicas WHERE server_id = ?")
    .get(serverId) as { max_port: number | null } | null;
  const maxPort = row?.max_port;
  return (maxPort && maxPort >= BASE_PORT) ? maxPort + 1 : BASE_PORT;
}
