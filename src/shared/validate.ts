import { NtfyBindingsSchema } from "./ntfy-schema.ts";
import { StorageBindingsSchema } from "./storage-schema.ts";
import type { InternalProtocol } from "./db/apps.ts";
import {
  DeployManifestSchema,
  RuntimeEnvSchema,
  RuntimeOutputsSchema,
  got as gotManifestValue,
  MIN_MEMORY_MB,
  MAX_MEMORY_MB,
  MIN_CPU_LIMIT,
  MAX_CPU_LIMIT,
  isValidMemoryMb,
  isValidCpuLimit,
  isValidRateLimitRps,
} from "./manifest-schema.ts";
import type { DeployManifest } from "./rpc.ts";
import { placementShapeError, volumePlacementError } from "./placement.ts";

// The manifest shape/bounds now live once in ./manifest-schema.ts (the Zod
// source of truth). Re-export the numeric bounds/predicates here so existing
// importers of them from ./validate.ts (e.g. server/routes/apps.ts) keep
// working unchanged.
export {
  MIN_MEMORY_MB,
  MAX_MEMORY_MB,
  MIN_CPU_LIMIT,
  MAX_CPU_LIMIT,
  isValidMemoryMb,
  isValidCpuLimit,
  isValidRateLimitRps,
};

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: string };

export function validateAppName(name: string): ValidationResult<string> {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return { valid: false, error: "App name is required" };
  if (trimmed.length > 63)
    return { valid: false, error: "App name must be 63 characters or fewer" };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(trimmed) && trimmed.length > 1)
    return {
      valid: false,
      error:
        "App name must start and end with a letter or digit, and contain only lowercase letters, digits, or hyphens",
    };
  if (trimmed.length === 1 && !/^[a-z0-9]$/.test(trimmed))
    return {
      valid: false,
      error: "App name must be a lowercase letter or digit",
    };
  if (/--/.test(trimmed))
    return { valid: false, error: "App name must not contain consecutive hyphens" };
  return { valid: true, value: trimmed };
}

export function validateDomain(domain: string): ValidationResult<string> {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return { valid: false, error: "Domain is required" };
  if (trimmed.length > 253)
    return { valid: false, error: "Domain must be 253 characters or fewer" };

  const labels = trimmed.split(".");
  if (labels.length < 2)
    return { valid: false, error: "Domain must have at least two labels (e.g., example.com)" };

  for (const label of labels) {
    if (!label)
      return { valid: false, error: "Domain contains empty labels" };
    if (label.length > 63)
      return { valid: false, error: `Domain label "${label}" exceeds 63 characters` };
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
      return {
        valid: false,
        error: `Domain label "${label}" must start and end with a letter or digit, and contain only letters, digits, or hyphens`,
      };
  }

  return { valid: true, value: trimmed };
}

export function validatePort(port: number): ValidationResult<number> {
  if (!Number.isInteger(port))
    return { valid: false, error: "Port must be an integer" };
  if (port < 1 || port > 65535)
    return { valid: false, error: "Port must be between 1 and 65535" };
  return { valid: true, value: port };
}

const RESERVED_ENV_PREFIXES = ["DOCKER_", "PATH", "HOME", "LD_", "DYLD_"];
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateEnvVars(
  vars: Record<string, string> | Array<{ key: string; value: string; secret?: boolean }>
): ValidationResult<Record<string, string>> {
  const entries = Array.isArray(vars)
    ? vars.map((v) => [v.key, v.value] as const)
    : Object.entries(vars);
  for (const [key, value] of entries) {
    if (!ENV_KEY_PATTERN.test(key))
      return {
        valid: false,
        error: `Environment variable key "${key}" is invalid. Keys must start with a letter or underscore and contain only letters, digits, or underscores.`,
      };
    if (RESERVED_ENV_PREFIXES.some((p) => key === p || key.startsWith(p + (p.endsWith("_") ? "" : "="))))
      // Only block exact matches for PATH/HOME, prefix matches for DOCKER_/LD_/DYLD_
      if (key === "PATH" || key === "HOME" || key.startsWith("DOCKER_") || key.startsWith("LD_") || key.startsWith("DYLD_"))
        return {
          valid: false,
          error: `Environment variable "${key}" uses a reserved prefix and cannot be set`,
        };
    if (value.includes("\0"))
      return {
        valid: false,
        error: `Environment variable "${key}" contains a null byte`,
      };
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return { valid: true, value: result };
}

/** Active HTTP health-check path (Traefik loadBalancer.healthCheck.path).
 *  "" = disabled. Must be an absolute path with no whitespace/control chars. */
export function validateHealthCheckPath(path: string): ValidationResult<string> {
  const trimmed = path.trim();
  if (!trimmed) return { valid: true, value: "" };
  if (!trimmed.startsWith("/"))
    return { valid: false, error: 'Health check path must start with "/"' };
  if (trimmed.length > 200)
    return { valid: false, error: "Health check path must be 200 characters or fewer" };
  if (!/^[!-~]+$/.test(trimmed))
    return { valid: false, error: "Health check path must not contain spaces or control characters" };
  return { valid: true, value: trimmed };
}

export function isInternalProtocol(value: unknown): value is InternalProtocol {
  return value === "http" || value === "tcp";
}

/**
 * Resolve a deploy request's internal routing protocol. `internal_protocol` is
 * an explicit, first-class field: a valid explicit value wins, otherwise it
 * defaults to "http". It is intentionally independent of `health_check` —
 * routing (L7 HTTP vs raw TCP pass-through) and the post-deploy probe (HTTP vs
 * container-running) are orthogonal, so a raw-TCP app (e.g. a database) must
 * set `internal_protocol: "tcp"` explicitly rather than relying on
 * `health_check`.
 */
export function resolveInternalProtocol(
  internalProtocol: unknown,
): InternalProtocol {
  return isInternalProtocol(internalProtocol) ? internalProtocol : "http";
}

/** Per-app ingress fields shared by deploy and the ingress-update endpoint.
 *  Every field is optional so a partial ingress PATCH validates only what it
 *  sends; deploy passes the full set. */
export type IngressFieldsInput = {
  rate_limit_rps?: number;
  health_check_path?: string;
};

/** Normalized ingress values (trimmed/joined) ready to persist. Only the keys
 *  that were present in the input are set. */
export type NormalizedIngressFields = {
  rate_limit_rps?: number;
  health_check_path?: string;
};

/**
 * Single source of truth for the ingress-field rules shared by
 * manifest and partial app-config apply paths. Returns the
 * normalized values (or the first error) so both call sites agree on both the
 * rules and the error strings. `httpRouted` is whether the app is (or will be)
 * HTTP-routed (internal_protocol='http') — an active health-check path is a
 * Traefik HTTP-router feature and can't apply to a raw-TCP-routed app.
 */
export function validateIngressFields(
  fields: IngressFieldsInput,
  ctx: { httpRouted: boolean },
): ValidationResult<NormalizedIngressFields> {
  const out: NormalizedIngressFields = {};

  if (fields.rate_limit_rps !== undefined) {
    if (!isValidRateLimitRps(fields.rate_limit_rps)) {
      return { valid: false, error: "Rate limit must be an integer 0 (unlimited) to 1000000 requests/sec" };
    }
    out.rate_limit_rps = fields.rate_limit_rps;
  }

  if (fields.health_check_path !== undefined) {
    const pathResult = validateHealthCheckPath(String(fields.health_check_path));
    if (!pathResult.valid) return { valid: false, error: pathResult.error };
    // The active HTTP health check lives on the app's HTTP loadBalancer;
    // raw-TCP-routed apps use a TCP connect check instead.
    if (pathResult.value && !ctx.httpRouted) {
      return { valid: false, error: "Health check path requires HTTP internal routing — raw-TCP apps use a TCP connect check instead (set internal_protocol to 'http')" };
    }
    out.health_check_path = pathResult.value;
  }

  return { valid: true, value: out };
}


export function validateHetznerToken(token: string): ValidationResult<string> {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, error: "Token is required" };
  if (trimmed.length < 32)
    return { valid: false, error: "Token is too short (minimum 32 characters)" };
  if (trimmed.length > 128)
    return { valid: false, error: "Token is too long (maximum 128 characters)" };
  if (!/^[\x20-\x7e]+$/.test(trimmed))
    return { valid: false, error: "Token contains invalid characters" };
  return { valid: true, value: trimmed };
}

export function validateGitHubPat(token: string): ValidationResult<string> {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, error: "Token is required" };
  if (trimmed.length < 30)
    return { valid: false, error: "Token is too short" };
  if (trimmed.length > 256)
    return { valid: false, error: "Token is too long" };
  if (!/^[\x20-\x7e]+$/.test(trimmed))
    return { valid: false, error: "Token contains invalid characters" };
  return { valid: true, value: trimmed };
}

/**
 * Reject host paths that aren't in the per-app/service or block-storage
 * allowlist. Stops a control-plane user from mounting `/etc`, `/root`, or
 * another app's data dir into their container. Called both at the RPC
 * boundary (early reject) and inside buildDockerRunArgs (defense in depth).
 */
export function assertSafeHostPath(hostPath: string, appName: string): void {
  if (typeof hostPath !== "string" || hostPath.length === 0)
    throw new Error("Volume host path is required");
  if (!hostPath.startsWith("/"))
    throw new Error(`Volume host path must be absolute: ${hostPath}`);
  if (hostPath.includes(".."))
    throw new Error(`Volume host path must not contain '..': ${hostPath}`);
  if (hostPath.includes("\0") || /\s/.test(hostPath))
    throw new Error(`Volume host path contains invalid characters: ${hostPath}`);
  // Collapse duplicate slashes for the prefix check, but reject anything that
  // would resolve outside the allowed roots.
  const normalized = hostPath.replace(/\/+/g, "/");

  // App name must be safe — we interpolate it into the allowed prefix.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(appName))
    throw new Error(`Invalid app name for volume scoping: ${appName}`);

  const allowedPrefixes = [
    `/home/deploy/apps/${appName}/`,
    `/home/deploy/services/${appName}/`,
    `/mnt/ocd-`, // block-storage mounts created by the volume provisioner
    `/mnt/vol-`, // pre-existing block volumes attached by id (attach-existing)
  ];
  const provisionedLocalVolume = new RegExp(`^/var/lib/ocd/volumes/ocd-${appName}-op[0-9]+(?:/|$)`).test(normalized);
  if (!provisionedLocalVolume && !allowedPrefixes.some((p) => normalized.startsWith(p)))
    throw new Error(
      `Volume host path "${hostPath}" is not in the allowlist. ` +
      `Allowed prefixes: ${allowedPrefixes.join(", ")}`,
    );
}

/**
 * Server-side (web-deploy) manifest validator: a result-style adapter over the
 * canonical `DeployManifestSchema`. The schema is the single source of truth
 * for the manifest SHAPE and numeric BOUNDS — this function no longer restates
 * them. It then layers the web-path-only semantic checks the schema doesn't
 * encode: the shared ingress rules (IP-allowlist format, health-check-path shape, public-port pool range,
 * and the HTTP-routing cross-field constraints). Unknown keys are tolerated
 * (forward-compat), matching the old behavior.
 */
export function validateDeployManifest(
  raw: unknown,
): { ok: true; manifest: DeployManifest } | { ok: false; error: string } {
  const parsed = DeployManifestSchema.safeParse(raw);
  if (!parsed.success) {
    // Unknown keys are non-fatal here (forward-compat); surface the first real
    // shape/bounds issue as a single human-readable string.
    const hard = parsed.error.issues.filter((i) => i.code !== "unrecognized_keys");
    const first = hard[0];
    if (first) {
      const field = first.path.map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".");
      const gotValue = fieldValueAt(raw, first.path);
      const suffix = first.code === "custom" ? "" : `, got ${gotManifestValue(gotValue)}`;
      return { ok: false, error: field ? `${field}: ${first.message}${suffix}` : `${first.message}${suffix}` };
    }
    // else: only unknown keys — fall through and treat as shape-valid.
  }

  const obj = raw as Record<string, unknown>;

  // Rate limit / health-check path share the deploy request's rules — one validator, one set of error strings. The
  // health-check-path HTTP-routing rule keys off the manifest's resolved
  // internal protocol (explicit internal_protocol, else the "http" default).
  const healthCheck = obj.health_check;
  const healthPath =
    healthCheck && typeof healthCheck === "object" && !Array.isArray(healthCheck)
      ? ((healthCheck as Record<string, unknown>).path as string | undefined)
      : undefined;
  const httpRouted = resolveInternalProtocol(obj.internal_protocol) === "http";
  const ingressInput: IngressFieldsInput = {};
  if ("rate_limit_rps" in obj) ingressInput.rate_limit_rps = obj.rate_limit_rps as number;
  if (healthPath !== undefined) ingressInput.health_check_path = healthPath;
  const ingressResult = validateIngressFields(ingressInput, { httpRouted });
  if (!ingressResult.valid) return { ok: false, error: ingressResult.error };

  return { ok: true, manifest: raw as DeployManifest };
}

/** Walk an object along a Zod issue path to recover the received value. */
function fieldValueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}


export function validateDeployRequest(req: {
  storage?: import("./storage-schema.ts").StorageBindings;
  notifications?: import("./ntfy-schema.ts").NtfyBindings;
  apply_mode?: "manifest";
  app_name: string;
  domain?: string;
  image_ref?: string;
  git_commit?: string;
  container_port: number;
  env?: import("./manifest-schema.ts").RuntimeEnv;
  outputs?: import("./manifest-schema.ts").RuntimeOutputs;
  environment?: string | null;
  environment_id?: number | null;
  volume_id?: string;
  volume_size?: number;
  placement?: Record<string, number>;
  memory_mb?: number;
  cpu_limit?: number;
  public?: boolean;
  health_check?: boolean;
  health_check_mode?: string;
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  health_check_expected_statuses?: number[];
  internal_protocol?: string;
  rate_limit_rps?: number;
  health_check_path?: string;
  compress?: boolean;
  command?: string[];
  cap_add?: string[];
  post_start_command?: string;
}): ValidationResult<void> {
  if (req.notifications !== undefined && !NtfyBindingsSchema.safeParse(req.notifications).success) {
    return { valid: false, error: "Invalid notification bindings" };
  }
  if (req.storage !== undefined) {
    const result = StorageBindingsSchema.safeParse(req.storage);
    if (!result.success) return { valid: false, error: `Storage: ${result.error.message}` };
  }
  const nameResult = validateAppName(req.app_name);
  if (!nameResult.valid) return { valid: false, error: `App name: ${nameResult.error}` };

  if (!req.image_ref || !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(req.image_ref)) {
    return { valid: false, error: "Image must be an immutable OCI reference ending in @sha256:<64 hex digest>" };
  }
  if (req.git_commit && !/^[0-9a-f]{7,64}$/i.test(req.git_commit)) {
    return { valid: false, error: "Git commit SHA must contain 7-64 hexadecimal characters" };
  }
  if (req.command !== undefined && (
    !Array.isArray(req.command) ||
    req.command.some((part) => typeof part !== "string" || part.length === 0 || /[\0\r\n]/.test(part))
  )) {
    return { valid: false, error: "Command must be an array of non-empty strings without control characters" };
  }
  if (req.cap_add !== undefined && (
    !Array.isArray(req.cap_add) ||
    req.cap_add.some((cap) => typeof cap !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(cap))
  )) {
    return { valid: false, error: "Linux capabilities must use names such as CHOWN or SETUID" };
  }
  if (req.post_start_command !== undefined && /[\0]/.test(req.post_start_command)) {
    return { valid: false, error: "Post-start command must not contain NUL bytes" };
  }

  if (req.domain) {
    if (req.public === false) {
      return { valid: false, error: "Private apps cannot have a public domain" };
    }
    const domainResult = validateDomain(req.domain);
    if (!domainResult.valid) return { valid: false, error: `Domain: ${domainResult.error}` };
  }

  const portResult = validatePort(req.container_port);
  if (!portResult.valid) return { valid: false, error: `Port: ${portResult.error}` };
  if (
    req.health_check_expected_statuses !== undefined &&
    (
      !Array.isArray(req.health_check_expected_statuses) ||
      req.health_check_expected_statuses.length === 0 ||
      req.health_check_expected_statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
    )
  ) {
    return { valid: false, error: "Health check expected statuses must be a non-empty array of HTTP codes 100-599" };
  }

  for (const field of ["env_vars", "env_projection", "exports"]) {
    if (field in req) return { valid: false, error: `${field} is not supported; use an explicit env map and outputs` };
  }
  for (const [label, schema, value] of [["env", RuntimeEnvSchema, req.env], ["outputs", RuntimeOutputsSchema, req.outputs]] as const) {
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (!parsed.success) return { valid: false, error: `${label}: ${parsed.error.message}` };
  }

  const placementError = placementShapeError(req.placement);
  if (placementError) return { valid: false, error: placementError };
  if (req.volume_size) {
    const volumeError = volumePlacementError(req.placement!);
    if (volumeError) return { valid: false, error: volumeError };
  }
  if (req.volume_size !== undefined && (!Number.isInteger(req.volume_size) || req.volume_size < 0)) {
    return { valid: false, error: "Volume size must be 0 or a positive integer" };
  }
  if (req.volume_id && !req.volume_size) {
    return { valid: false, error: "An explicit provider volume requires a positive desired size" };
  }

  if (req.memory_mb !== undefined && !isValidMemoryMb(req.memory_mb)) {
    return { valid: false, error: `Memory: must be an integer 0 (default) or ${MIN_MEMORY_MB}–${MAX_MEMORY_MB} MB` };
  }

  if (req.cpu_limit !== undefined && !isValidCpuLimit(req.cpu_limit)) {
    return { valid: false, error: `CPU: must be 0 (default) or a number ${MIN_CPU_LIMIT}–${MAX_CPU_LIMIT} cores` };
  }

  if (req.internal_protocol !== undefined && !isInternalProtocol(req.internal_protocol)) {
    return { valid: false, error: 'Internal protocol must be "http" or "tcp"' };
  }

  // Internal routing protocol: explicit value wins, else the "http" default
  // (independent of health_check). The health-check-path rule keys off the
  // resolved routing protocol (it is an HTTP-router feature).
  const internalProtocol = resolveInternalProtocol(req.internal_protocol);

  const healthMode = req.health_check_mode ?? (req.health_check === false ? "container" : "http");
  if (!["http", "container", "exec", "heartbeat"].includes(healthMode)) {
    return { valid: false, error: "Health check mode is invalid" };
  }
  if (healthMode === "exec" && !req.health_check_command?.trim()) {
    return { valid: false, error: "Exec health checks require health_check.command" };
  }
  if (healthMode === "heartbeat") {
    if (!req.health_check_file || !/^\/[A-Za-z0-9._/-]+$/.test(req.health_check_file)) {
      return { valid: false, error: "heartbeat health checks require a safe absolute file path" };
    }
    if (!Number.isInteger(req.health_check_max_age_seconds) || (req.health_check_max_age_seconds ?? 0) < 1) {
      return { valid: false, error: "heartbeat health checks require max_age_seconds >= 1" };
    }
  }
  if (healthMode !== "http" && req.health_check_path) {
    return { valid: false, error: "health_check.path is only valid for HTTP health checks" };
  }

  // Rate limit / health-check path rules are shared with the ingress-update
  // endpoint — one validator, one set of errors.
  const ingressResult = validateIngressFields(
    {
      rate_limit_rps: req.rate_limit_rps,
      health_check_path: req.health_check_path,
    },
    { httpRouted: internalProtocol === "http" },
  );
  if (!ingressResult.valid) return { valid: false, error: ingressResult.error };

  return { valid: true, value: undefined };
}

const BUILD_REPOSITORY = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+(?:\.git)?$/;
const BUILD_IMAGE = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/i;

/** Validate a request before its source is built. Runtime deploy operations
 * still receive and validate only the resulting immutable image_ref. */
export function validateBuildDeployRequest(req: Parameters<typeof validateDeployRequest>[0] & {
  build?: {
    repository: string;
    branch?: string;
    dockerfile: string;
    context: string;
    image_repository: string;
    platform?: "linux/amd64";
    cache?: boolean;
    webhook?: boolean;
  };
}): ValidationResult<void> {
  const build = req.build;
  if (!build) return { valid: false, error: "Build configuration is required" };
  if (!BUILD_REPOSITORY.test(build.repository)) {
    return { valid: false, error: "Build repository must be an HTTPS Git URL" };
  }
  if (!(build.branch || "main").trim() || /[\s~^:?*\\\[]/.test(build.branch || "main")) {
    return { valid: false, error: "Build branch is invalid" };
  }
  for (const [label, value] of [["Dockerfile", build.dockerfile], ["Build context", build.context]] as const) {
    if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
      return { valid: false, error: `${label} must be a safe repository-relative path` };
    }
  }
  if (!BUILD_IMAGE.test(build.image_repository) || build.image_repository.includes("@") || /:[^/]+$/.test(build.image_repository)) {
    return { valid: false, error: "Build image repository must be an OCI repository without a tag or digest" };
  }
  if (build.platform !== undefined && build.platform !== "linux/amd64") {
    return { valid: false, error: "Build platform must be linux/amd64" };
  }
  if (build.cache !== undefined && typeof build.cache !== "boolean") {
    return { valid: false, error: "Build cache must be a boolean" };
  }
  if (!req.git_commit || !/^[0-9a-f]{40,64}$/i.test(req.git_commit)) {
    return { valid: false, error: "OCD builds require an exact 40-64 character Git commit SHA" };
  }
  return validateDeployRequest({
    ...req,
    image_ref: `${build.image_repository}@sha256:${"0".repeat(64)}`,
  });
}
