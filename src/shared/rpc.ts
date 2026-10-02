export type Server = {
  id: number;
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  routing_address: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  created_at: string;
};

export type PlacementEntry = { server_id: number; server_name: string; replicas: number };

export type App = {
  id: number;
  /** Servers this app currently has replicas on (derived). */
  servers: number[];
  name: string;
  domain: string;
  container_port: number;
  /** Host port of the first replica (derived for display continuity). */
  host_port: number;
  env_vars: string;
  status: string;
  /** Declared placement, one entry per server. */
  placement: PlacementEntry[];
  volume_id: string;
  volume_mount: string;
  volume_driver: string;
  health_check: number; // 1 = HTTP probe (default); 0 = only verify the container is running
  internal_protocol: string; // 'http' | 'tcp' — internal routing protocol (independent of health_check)
  rate_limit_rps: number; // public-router rate limit in req/s; 0 = unlimited
  health_check_path: string; // active HTTP health-check path; "" = off
  compress: number; // 1 = response compression on the public router
  created_at: string;
};

export type Replica = {
  id: number;
  app_id: number;
  server_id: number;
  host_port: number;
  container_name: string;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  last_health_at: string;
  created_at: string;
};

export type ReplicaEvent = {
  id: number;
  app_id: number;
  event_type: string;
  from_count: number;
  to_count: number;
  reason: string;
  created_at: string;
};

export type DeploymentRecord = {
  id: number;
  app_id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  created_at: string;
};

export type ServerWithApps = Server & { apps: App[] };

export type EnvVarEntry = {
  key: string;
  value: string;
  secret: boolean;
  updated_at: string;
  encrypted_value?: string;
  iv?: string;
};

export type DeployRequest = {
  /** Internal owning stack context for resolving dependency outputs. */
  stack_id?: number | null;
  storage?: import("./storage-schema.ts").StorageBindings;
  notifications?: import("./ntfy-schema.ts").NtfyBindings;
  /** Complete manifest reconciliation. Browser/API patches are not supported. */
  apply_mode?: "manifest";
  app_name: string;
  /** Internal manifest provenance for build-source attachment cleanup. */
  delivery_source?: "build" | "image";
  /** OCD-owned BuildKit delivery. API routes replace this with an exact
   * image_ref before entering the runtime deploy/redeploy operations. */
  build?: {
    repository: string;
    branch?: string;
    dockerfile: string;
    context: string;
    image_repository: string;
    platform?: "linux/amd64";
    cache?: boolean;
    inputs?: string[];
    webhook?: boolean;
  };
  domain?: string;
  container_port: number;
  env?: DeployManifest["env"];
  outputs?: DeployManifest["outputs"];
  /** Portable manifest selector. Resolved server-side when environment_id is omitted. */
  environment?: string | null;
  environment_id?: number | null; // Link to an existing environment; null explicitly detaches
  volume_id?: string; // Explicit Hetzner volume to adopt; empty = OCD-managed or none
  volume_size?: number; // Desired GB; 0 = explicitly no primary volume
  volume_path?: string; // Container mount path, defaults to /data
  volume_driver?: string; // Storage driver id; omitted selects the target server's default
  /** Explicit placement: server name or numeric id -> replica count. OCD
   * never chooses servers or replica counts on its own. */
  placement: Record<string, number>;
  public?: boolean; // Whether the app is publicly accessible (default true)
  memory_mb?: number; // Per-container memory ceiling in MB. Omit / 0 → platform default
  cpu_limit?: number; // Per-container CPU ceiling in cores (fractional allowed). Omit / 0 → platform default
  command?: string[]; // Optional argv appended after the OCI image
  cap_add?: string[]; // Explicit Linux capabilities restored after cap-drop=ALL
  post_start_command?: string; // Idempotent command executed after a healthy rollout
  health_check?: boolean; // Default true; false = skip the HTTP probe, only verify the container is running
  health_check_mode?: "http" | "container" | "exec" | "heartbeat";
  health_check_command?: string;
  health_check_file?: string;
  health_check_max_age_seconds?: number;
  health_check_expected_statuses?: number[];
  /** Immutable prebuilt OCI image. Production artifact deployments require
   * an @sha256 digest; tags are never accepted as deploy identity. */
  image_ref?: string;
  /** Optional source provenance supplied by external CI. Never fetched by OCD. */
  git_commit?: string;
  internal_protocol?: "http" | "tcp"; // Internal routing protocol (independent of health_check); omit → "http". Raw-TCP apps must set "tcp".
  rate_limit_rps?: number; // Public-router rate limit in req/s; omit / 0 = unlimited
  health_check_path?: string; // Active HTTP health-check path (e.g. /healthz); omit / "" = off. Requires health_check !== false
  compress?: boolean; // Response compression on the public router
  /** Client-computed provenance for an explicitly applied manifest. These are
   * metadata only; the normalized fields above remain the desired spec. */
  manifest_path?: string;
  manifest_hash?: string;
  /** Owning stack control file, populated for stack members. */
  stack_manifest_path?: string | null;
};

export type ReleaseRequest = {
  image: string;
  /** Optional source revision for audit/provenance only. */
  commit?: string;
};

export type PanelInfo = {
  id: number;
  server_id: number;
  name: string;
  domain: string;
  image_ref: string;
  container_port: number;
  host_port: number;
  volume_id: string;
  volume_mount: string;
  env_vars: string;
  status: string;
  created_at: string;
};

export type PanelDeployment = {
  id: number;
  image_tag: string;
  git_commit: string;
  status: string;
  source: string;
  deploy_log: string;
  created_at: string;
};

// The manifest shapes are DERIVED (via `z.infer`) from the canonical Zod
// schemas in `./manifest-schema.ts` — re-exported here so existing importers of
// these types from `./rpc.ts` keep working. See that file for the per-field
// documentation. This keeps the manifest type and its validator from drifting
// (the drift that once let `"health_check": false` slip past the types).
import type { DeployManifest, StackManifest } from "./manifest-validate.ts";
export type { DeployManifest, StackManifest };

export type StackDeployRequest = {
  name: string;
  /** Canonical repository-relative owning stack manifest. */
  stack_manifest_path?: string;
  /** Optional partial reconcile selection. Omission means every member. */
  selected_app_keys?: string[];
  /** Partial runs never interpret omitted members as desired removals. */
  partial?: boolean;
  /** Apply desired configuration without changing the released artifact. */
  config_only?: boolean;
  environment_id?: number | null;
  /** Stack members resolved to immutable artifacts before runtime deployment. */
  apps: Array<Omit<DeployRequest, "environment_id"> & {
    key: string;
    needs?: string[];
    /** Client preflight hint. The server promotes this mode when an
     * authoritative config diff requires a more disruptive action. */
    reconcile_mode?: "control" | "runtime" | "artifact";
  }>;
};

export type ParsedManifest = {
  path: string;
  dir: string;
  manifest: DeployManifest;
};

export type Settings = {
  default_domain_suffix: string;
};
