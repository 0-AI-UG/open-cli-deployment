import { getAppNtfy, normalizeNtfyBindings, saveAppNtfy, prepareNtfyBindings } from "./ntfy.ts";
import { getAppStorage, resolveStorageBindings, saveAppStorage, prepareStorageBindings } from "./object-storage.ts";
import * as db from "./db.ts";
import type { AppRow } from "./db/apps.ts";
import type { DeployRequest } from "./rpc.ts";
import { parseRuntimeConfig, serializeRuntimeConfig, preflightRuntimeEnv, runtimeAppFromRequest } from "./runtime-env.ts";
import { describePlacement, parsePlacement, resolvePlacement, type Placement } from "./placement.ts";
import { normalizePublicPorts, publicPortConflicts, type PublicPort } from "./public-ports.ts";
import { validateDeployRequest } from "./validate.ts";

export type AppConfigChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type AppReconcileMode = "control" | "runtime" | "artifact";

const ARTIFACT_CONFIG_FIELDS = new Set(["image_ref"]);

const RUNTIME_CONFIG_FIELDS = new Set([
  "notifications", "storage", "container_port", "environment_id", "env", "outputs", "memory_mb", "cpu_limit",
  "health_check", "health_check_mode", "health_check_command", "health_check_file",
  "health_check_max_age_seconds", "health_check_expected_statuses", "internal_protocol",
  "desired_volume_id", "desired_volume_size", "desired_volume_path", "desired_volume_driver",
  "command", "cap_add", "public_ports",
]);

/** Classify the least disruptive convergence action for a desired-config diff.
 * Artifact identity and runtime execution settings require container
 * recreation; placement and replica count are control-plane only. */
export function classifyAppConfigChanges(changes: AppConfigChange[]): AppReconcileMode {
  if (changes.some((change) => ARTIFACT_CONFIG_FIELDS.has(change.field))) return "artifact";
  if (changes.some((change) => RUNTIME_CONFIG_FIELDS.has(change.field))) return "runtime";
  return "control";
}

/** A config-only apply keeps runtime settings truthful by recreating
 * containers from the current immutable artifact. */
export function classifyConfigOnlyChanges(
  changes: AppConfigChange[],
  options: { environmentChanged?: boolean } = {},
): { rollout: "control" | "runtime"; pendingRollout: boolean } {
  const pendingRollout = changes.some((change) => ARTIFACT_CONFIG_FIELDS.has(change.field));
  const runtime = options.environmentChanged === true ||
    changes.some((change) => RUNTIME_CONFIG_FIELDS.has(change.field));
  return { rollout: runtime ? "runtime" : "control", pendingRollout };
}

function environmentIdByName(name: string): number {
  const normalized = name.trim().toLowerCase();
  const environment = db.getEnvironments().find((candidate) =>
    candidate.name.toLowerCase() === normalized
  );
  if (!environment) throw new Error(`Environment not found: ${name}`);
  return environment.id;
}

/** Resolve portable environment-name selectors before persistence/operations. */
export function resolveDeployRequestEnvironmentIds(req: DeployRequest): DeployRequest {
  const resolved = { ...req };
  if (resolved.environment_id === undefined && resolved.environment !== undefined) {
    resolved.environment_id = resolved.environment === null
      ? null
      : environmentIdByName(resolved.environment);
  }
  return resolved;
}

/** Resolve a request's placement (server names or ids) to stored server ids.
 * Unknown or ambiguous servers fail; OCD never substitutes another server. */
export function resolveRequestPlacement(req: Pick<DeployRequest, "placement">): Placement {
  return resolvePlacement(req.placement, db.getServers());
}

/** Every server an app is placed on must exist, be ready, and not be a
 * dedicated build worker. Placing on the panel server is allowed. */
export function assertPlacementUsable(placement: Placement): void {
  for (const id of Object.keys(placement).map(Number)) {
    const server = db.getServer(id);
    if (!server) throw new Error(`Placement server #${id} does not exist`);
    if (db.getBuildWorkerByServerId(id)) {
      throw new Error(`Placement server ${server.name} is a dedicated build worker and cannot run apps`);
    }
    if (server.status !== "ready") {
      throw new Error(`Placement server ${server.name} is not ready (status: ${server.status})`);
    }
  }
}

/** No two apps may claim an overlapping public port on the same server.
 * `placement` is resolved (server id keys). */
export function assertPublicPortsAvailable(appName: string, ports: PublicPort[], placement: Placement): void {
  if (ports.length === 0) return;
  const others = db.getApps().map((other) => ({
    name: other.name,
    placement: parsePlacement(other.placement),
    public_ports: db.parseAppPublicPorts(other),
  }));
  const conflicts = publicPortConflicts(
    { name: appName, placement, public_ports: ports },
    others,
    (id) => db.getServer(Number(id))?.name ?? `#${id}`,
  );
  if (conflicts.length > 0) throw new Error(`Public port conflict: ${conflicts.join("; ")}`);
}

/** Gate a placement change for an existing app: a volume app may not change
 * servers (that is `ocd move`), and every newly declared server must be usable.
 * An unchanged placement is always accepted. */
export function assertPlacementChangeAllowed(app: AppRow, volumeSize: number, next: Placement): void {
  if (sameValue(parsePlacement(app.placement), next)) return;
  assertVolumePlacementUnchanged(app, volumeSize, next);
  assertPlacementUsable(next);
}

/** A volume app's data lives on its one placed server; changing that server is
 * a data move, which only `ocd move` performs. */
function assertVolumePlacementUnchanged(app: AppRow, volumeSize: number, next: Placement): void {
  if (!volumeSize && !app.volume_id) return;
  const current = parsePlacement(app.placement);
  const currentIds = Object.keys(current);
  if (currentIds.length === 0) return;
  const nextIds = Object.keys(next);
  if (currentIds.length === nextIds.length && currentIds.every((id) => nextIds.includes(id))) return;
  const servers = db.getServers();
  const target = servers.find((server) => String(server.id) === nextIds[0])?.name ?? nextIds[0];
  throw new Error(
    `App ${app.name} has a volume on ${describePlacement(current, servers)}; changing its placement moves its data. ` +
    `Run \`ocd move ${app.name} --to ${target}\` instead.`,
  );
}

/** Normalize a complete manifest application for an existing app.
 *
 * Runtime-assigned identity (the generated domain), stack ownership, and attached-volume state
 * are retained. Every manifest-owned scalar uses its documented default.
 */
export function mergeDeployRequestWithExistingApp(
  app: AppRow,
  manifest: Partial<DeployRequest> & { dry_run?: boolean; deploy?: boolean },
): DeployRequest {
  const supplied = resolveDeployRequestEnvironmentIds({
    ...manifest,
    app_name: manifest.app_name ?? app.name,
    container_port: manifest.container_port ?? app.container_port,
    placement: manifest.placement ?? parsePlacement(app.placement),
  });
  const publicApp = supplied.public !== undefined
    ? supplied.public
    : true;
  const merged: DeployRequest = {
    apply_mode: "manifest",
    app_name: supplied.app_name,
    domain: publicApp ? supplied.domain ?? app.domain : "",
    image_ref: supplied.image_ref ?? "",
    container_port: supplied.container_port,
    env: supplied.env ?? {},
    outputs: supplied.outputs ?? {},
    storage: resolveStorageBindings(supplied.storage),
    notifications: normalizeNtfyBindings(supplied.notifications),
    public: publicApp,
    memory_mb: supplied.memory_mb ?? 0,
    cpu_limit: supplied.cpu_limit ?? 0,
    health_check: supplied.health_check ?? true,
    health_check_mode: supplied.health_check_mode ??
      (supplied.health_check !== undefined
        ? supplied.health_check ? "http" : "container"
        : "http"),
    health_check_command: supplied.health_check_command ?? "",
    health_check_file: supplied.health_check_file ?? "",
    health_check_max_age_seconds: supplied.health_check_max_age_seconds ?? 0,
    health_check_expected_statuses: supplied.health_check_expected_statuses ?? [200],
    environment: supplied.environment,
    environment_id: supplied.environment_id ?? null,
    internal_protocol: supplied.internal_protocol ?? "http",
    rate_limit_rps: supplied.rate_limit_rps ?? 0,
    health_check_path: supplied.health_check_path ?? "",
    compress: supplied.compress ?? false,
    placement: supplied.placement,
    volume_id: supplied.volume_id ?? "",
    volume_driver: supplied.volume_driver ?? app.desired_volume_driver ?? undefined,
    volume_size: supplied.volume_size ?? 0,
    volume_path: supplied.volume_path ?? "/data",
    manifest_path: supplied.manifest_path,
    manifest_hash: supplied.manifest_hash,
    command: supplied.command ?? db.parseAppCommand(app),
    cap_add: supplied.cap_add ?? db.parseAppCapabilities(app),
    public_ports: supplied.public_ports ?? db.parseAppPublicPorts(app),
  };
  return merged;
}

function normalizedSpec(req: DeployRequest) {
  return {
    domain: req.domain ?? "",
    image_ref: req.image_ref ?? "",
    container_port: req.container_port,
    environment_id: req.environment_id,
    env: req.env ?? {},
    outputs: req.outputs ?? {},
    storage: req.storage ?? {},
    notifications: normalizeNtfyBindings(req.notifications),
    public: req.public ?? true,
    memory_mb: req.memory_mb ?? 0,
    cpu_limit: req.cpu_limit ?? 0,
    health_check: req.health_check_mode ? req.health_check_mode === "http" : (req.health_check ?? true),
    health_check_mode: req.health_check_mode ?? (req.health_check === false ? "container" : "http"),
    health_check_command: req.health_check_command ?? "",
    health_check_file: req.health_check_file ?? "",
    health_check_max_age_seconds: req.health_check_max_age_seconds ?? 0,
    health_check_expected_statuses: req.health_check_expected_statuses ?? [200],
    internal_protocol: req.internal_protocol ?? "http",
    rate_limit_rps: req.rate_limit_rps ?? 0,
    health_check_path: req.health_check_path ?? "",
    compress: req.compress ?? false,
    placement: resolveRequestPlacement(req),
    desired_volume_id: req.volume_id ?? "",
    desired_volume_size: req.volume_size ?? 0,
    desired_volume_path: req.volume_path ?? "/data",
    desired_volume_driver: req.volume_driver ?? "",
    command: req.command ?? [],
    cap_add: req.cap_add ?? [],
    public_ports: normalizePublicPorts(req.public_ports ?? []),
  };
}

function comparableApp(app: AppRow) {
  return {
    domain: app.domain || "",
    image_ref: app.image_ref || "",
    container_port: app.container_port,
    environment_id: app.environment_id,
    ...parseRuntimeConfig(app.env_vars),
    storage: getAppStorage(app.id),
    notifications: getAppNtfy(app.id),
    public: !!app.public,
    memory_mb: app.memory_mb ?? 0,
    cpu_limit: app.cpu_limit ?? 0,
    health_check: !!app.health_check,
    health_check_mode: app.health_check_mode || (app.health_check ? "http" : "container"),
    health_check_command: app.health_check_command || "",
    health_check_file: app.health_check_file || "",
    health_check_max_age_seconds: app.health_check_max_age_seconds || 0,
    health_check_expected_statuses: (() => {
      try {
        const parsed = JSON.parse(app.health_check_expected_statuses || "[200]");
        return Array.isArray(parsed) ? parsed : [200];
      } catch { return [200]; }
    })(),
    internal_protocol: app.internal_protocol || "http",
    rate_limit_rps: app.rate_limit_rps ?? 0,
    health_check_path: app.health_check_path || "",
    compress: !!app.compress,
    placement: parsePlacement(app.placement),
    desired_volume_id: app.desired_volume_id || "",
    desired_volume_size: app.desired_volume_size ?? 0,
    desired_volume_path: app.desired_volume_path || "/data",
    desired_volume_driver: app.desired_volume_driver || "",
    command: db.parseAppCommand(app),
    cap_add: db.parseAppCapabilities(app),
    public_ports: db.parseAppPublicPorts(app),
  };
}

/** Reconstruct the complete desired app spec from persisted state. Release
 * endpoints use this as an atomic candidate and replace only `image_ref`, so
 * publishing a new artifact can never reset unrelated configuration. */
export function deployRequestFromApp(app: AppRow): DeployRequest {
  const current = comparableApp(app);
  return {
    apply_mode: "manifest",
    app_name: app.name,
    domain: current.domain,
    image_ref: app.image_ref,
    container_port: app.container_port,
    environment_id: app.environment_id,
    ...parseRuntimeConfig(app.env_vars),
    storage: getAppStorage(app.id),
    notifications: getAppNtfy(app.id),
    public: current.public,
    memory_mb: current.memory_mb,
    cpu_limit: current.cpu_limit,
    health_check: current.health_check,
    health_check_mode: current.health_check_mode as DeployRequest["health_check_mode"],
    health_check_command: current.health_check_command,
    health_check_file: current.health_check_file,
    health_check_max_age_seconds: current.health_check_max_age_seconds,
    health_check_expected_statuses: current.health_check_expected_statuses,
    internal_protocol: current.internal_protocol as DeployRequest["internal_protocol"],
    rate_limit_rps: current.rate_limit_rps,
    health_check_path: current.health_check_path,
    compress: current.compress,
    placement: current.placement,
    volume_id: app.desired_volume_id,
    volume_size: app.desired_volume_size,
    volume_path: app.desired_volume_path,
    volume_driver: app.desired_volume_driver || undefined,
    command: current.command,
    cap_add: current.cap_add,
    public_ports: current.public_ports,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  };
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Diff an explicit manifest/API spec against OCD's currently stored desired
 * configuration. Secrets are intentionally absent from the diff. */
export function diffAppConfig(app: AppRow, req: DeployRequest): AppConfigChange[] {
  const effective = mergeDeployRequestWithExistingApp(app, req);
  const before = comparableApp(app) as Record<string, unknown>;
  const spec = normalizedSpec(effective);
  assertPlacementChangeAllowed(app, effective.volume_size ?? 0, spec.placement);
  assertPublicPortsAvailable(app.name, spec.public_ports, spec.placement);
  const after = spec as Record<string, unknown>;
  const changes: AppConfigChange[] = [];
  for (const [field, value] of Object.entries(after)) {
    if (!sameValue(before[field], value)) {
      const redact = (input: unknown) => field === "env"
        ? Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).map(([key, entry]) => [key, typeof entry === "string" ? "••••••••" : entry]))
        : field === "outputs"
          ? Object.fromEntries(Object.entries((input ?? {}) as Record<string, unknown>).map(([key]) => [key, "••••••••"]))
          : input;
      changes.push({ field, before: redact(before[field]), after: redact(value) });
    }
  }
  return changes;
}

async function applyEnvironment(app: AppRow, req: DeployRequest): Promise<void> {
  if (req.environment_id !== undefined && req.environment_id !== app.environment_id) {
    if (req.environment_id !== null && !db.getEnvironment(req.environment_id)) {
      throw new Error("Environment not found");
    }
    db.updateAppEnvironment(app.id, req.environment_id);
  }
  const config = serializeRuntimeConfig(req);
  if (!sameValue(parseRuntimeConfig(config), parseRuntimeConfig(app.env_vars))) db.updateAppEnvVars(app.id, config);
}

/** Apply a complete normalized desired spec to an existing app. It never
 * deploys code and never deletes an environment; callers decide whether to
 * enqueue a rollout after the configuration transaction succeeds. */
export async function applyAppConfig(
  appId: number,
  req: DeployRequest,
  opts: {
    userId?: string;
    log?: (line: string) => void;
    allowUnchangedLegacyVolumeIntent?: boolean;
    forceRevision?: boolean;
  } = {},
): Promise<AppConfigChange[]> {
  const app = db.getApp(appId);
  if (!app) throw new Error("App not found");
  const effective = mergeDeployRequestWithExistingApp(app, req);
  const preservesLegacyVolumeIntent = opts.allowUnchangedLegacyVolumeIntent === true &&
    app.desired_volume_size < 0 &&
    effective.volume_size === app.desired_volume_size &&
    effective.volume_id === app.desired_volume_id &&
    effective.volume_path === app.desired_volume_path;
  const effectiveValidation = validateDeployRequest(preservesLegacyVolumeIntent
    ? { ...effective, volume_id: "", volume_size: 0 }
    : effective);
  if (!effectiveValidation.valid) throw new Error(effectiveValidation.error);
  if (effective.app_name !== app.name) throw new Error(`Manifest targets "${effective.app_name}", but app #${appId} is "${app.name}"`);
  const desired = normalizedSpec(effective);
  const changes = diffAppConfig(app, effective);
  const changed = new Set(changes.map((c) => c.field));
  await preflightRuntimeEnv(runtimeAppFromRequest(effective, app.stack_id));
  await prepareStorageBindings(app, desired.storage);
  await prepareNtfyBindings(app.id, desired.notifications);
  await applyEnvironment(app, effective);
  if (changed.has("storage")) saveAppStorage(app.id, desired.storage);
  if (changed.has("notifications")) saveAppNtfy(app.id, desired.notifications);
  if ([
    "image_ref", "health_check_mode", "health_check_command",
    "health_check_file", "health_check_max_age_seconds", "health_check_expected_statuses",
  ].some((f) => changed.has(f))) {
    db.updateAppArtifactAndHealth(app.id, {
      imageRef: desired.image_ref,
      healthMode: desired.health_check_mode,
      healthCommand: desired.health_check_command,
      healthFile: desired.health_check_file,
      healthMaxAgeSeconds: desired.health_check_max_age_seconds,
      healthExpectedStatuses: desired.health_check_expected_statuses,
    });
  }
  if (changed.has("container_port")) db.updateAppContainerPort(app.id, desired.container_port);
  if (changed.has("domain") && req.domain !== undefined) db.updateAppDomain(app.id, req.domain);
  if (changed.has("public")) db.updateAppPublic(app.id, desired.public);
  if (changed.has("memory_mb")) db.updateAppMemory(app.id, desired.memory_mb);
  if (changed.has("cpu_limit")) db.updateAppCpu(app.id, desired.cpu_limit);
  if (changed.has("internal_protocol")) db.updateAppInternalProtocol(app.id, desired.internal_protocol);
  if (["rate_limit_rps", "health_check_path", "compress", "health_check"].some((f) => changed.has(f))) {
    db.updateAppIngressSettings(app.id, {
      rate_limit_rps: desired.rate_limit_rps,
      health_check_path: desired.health_check_path,
      compress: desired.compress,
      health_check: desired.health_check,
    });
  }
  if (["command", "cap_add"].some((f) => changed.has(f))) {
    db.updateAppRuntimeOptions(app.id, {
      command: desired.command,
      capAdd: desired.cap_add,
    });
  }
  if (["desired_volume_id", "desired_volume_size", "desired_volume_path", "desired_volume_driver"].some((f) => changed.has(f))) {
    db.updateAppDesiredVolume(app.id, {
      volumeId: desired.desired_volume_id,
      sizeGb: desired.desired_volume_size,
      mountPath: desired.desired_volume_path,
      driverId: desired.desired_volume_driver,
    });
  }
  if (changed.has("public_ports")) db.updateAppPublicPorts(app.id, desired.public_ports);
  if (changed.has("placement")) db.updateAppPlacement(app.id, desired.placement);
  if (opts.userId) db.updateAppDeployedBy(app.id, opts.userId);
  db.normalizeAppConfigRevision(app.id, app.config_revision, opts.forceRevision);
  if (effective.manifest_path && effective.manifest_hash) {
    db.recordAppManifestApplied(app.id, effective.manifest_path, effective.manifest_hash);
  }
  return changes;
}
