import { NtfyBindingsSchema } from "./ntfy-schema.ts";
import { StorageBindingsSchema } from "./storage-schema.ts";
/**
 * Canonical, single-source-of-truth Zod schemas for deploy (`.ocd-deploy.json`)
 * and stack (`ocd-stack.json`) manifests. The TypeScript manifest *types* are
 * DERIVED from these schemas via `z.infer` (see the `DeployManifest` /
 * `StackManifest` re-exports in `./rpc.ts`) so the shape and the validator can
 * never drift — the drift that once let `"health_check": false` (a boolean)
 * slip past the types and break a deploy.
 *
 * Dependency-light (zod only) so it's safe to import from the compiled CLI
 * bundle. It imports nothing from `./rpc.ts` (that would be a cycle) or
 * `./validate.ts`; instead the numeric bounds/predicates that used to live in
 * `./validate.ts` now live HERE and `./validate.ts` re-exports them.
 *
 * The user-facing validators (`validateDeployManifest` / `validateStackManifest`
 * in `./manifest-validate.ts`) run these schemas with `safeParse` and map the
 * Zod issues onto field-level "expected … got …" messages.
 */
import { z } from "zod";
import { volumePlacementError } from "./placement.ts";
import { PublicPortsSchema, publicPortsAppErrors } from "./public-ports.ts";

// --- numeric bounds + predicates (formerly in ./validate.ts) ----------------

/** Per-app container memory ceiling bounds (MB). 0 means "platform default". */
export const MIN_MEMORY_MB = 128;
export const MAX_MEMORY_MB = 32768;

export function isValidMemoryMb(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 || (value >= MIN_MEMORY_MB && value <= MAX_MEMORY_MB))
  );
}

/** Per-app container CPU ceiling bounds (cores). 0 means "platform default".
 *  Fractional values are allowed (docker's --cpus flag), so we don't require an
 *  integer — only a finite value in range with sane precision. */
export const MIN_CPU_LIMIT = 0.1;
export const MAX_CPU_LIMIT = 32;

export function isValidCpuLimit(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value === 0) return true;
  // Reject nonsense precision (e.g. 0.333333) that docker would round oddly.
  if (Math.round(value * 100) !== value * 100) return false;
  return value >= MIN_CPU_LIMIT && value <= MAX_CPU_LIMIT;
}

/** Public-router rate limit in requests/second; 0 = unlimited. */
export function isValidRateLimitRps(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- "got"/"jsonType" renderers (shared with manifest-validate.ts) ----------

/** JSON-ish type name, distinguishing arrays and null from "object". */
export function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | "undefined"
}

/** Human-readable "got" descriptor, e.g. `boolean (false)`, `"tpc"`, `number (3.5)`. */
export function got(v: unknown): string {
  const t = jsonType(v);
  if (t === "boolean" || t === "number") return `${t} (${String(v)})`;
  if (t === "string") return `"${String(v)}"`;
  return t;
}

// --- schema building blocks -------------------------------------------------

/**
 * A number field that fails with ONE unified "expected …" phrase whether the
 * value is the wrong type (Zod's built-in `invalid_type`, whose message the
 * validator suffixes with `, got …`) or the right type but out of range (our
 * refine, which renders the full `…, got …` message itself). Both routes yield
 * the same final wording, matching the old hand-written validator.
 */
function guardedNumber(phrase: string, ok: (v: number) => boolean) {
  return z
    .number({ error: phrase })
    .refine(ok, { error: (iss) => `${phrase}, got ${got(iss.input)}` });
}

/** A non-empty (after trim) string field with a unified "expected …" phrase. */
function nonEmptyString(phrase: string) {
  return z
    .string({ error: phrase })
    .refine((v) => v.trim().length > 0, {
      error: (iss) => `${phrase}, got ${got(iss.input)}`,
    });
}

// --- deploy manifest --------------------------------------------------------

const buildSchema = z.object({
  /** HTTPS Git repository cloned by OCD on a dedicated build worker. */
  repository: z.string({ error: "expected HTTPS Git repository URL" }).refine(
    (value) => /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+(?:\.git)?$/.test(value),
    { error: (iss) => `expected HTTPS Git repository URL, got ${got(iss.input)}` },
  ),
  branch: nonEmptyString("expected a non-empty branch name").optional(),
  dockerfile: nonEmptyString("expected a repository-relative Dockerfile path"),
  context: nonEmptyString("expected a repository-relative build context"),
  /** Mutable OCI repository where OCD pushes the built image. */
  image_repository: z.string({ error: "expected OCI repository" }).refine(
    (value) => /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/i.test(value),
    { error: (iss) => `expected OCI repository without a tag or digest, got ${got(iss.input)}` },
  ),
  /** Builds are reproducible on the fleet's explicitly supported runtime ABI. */
  platform: z.literal("linux/amd64", { error: "expected linux/amd64" }).optional(),
  /** Complete repository-relative files/directories consumed by this build. */
  inputs: z.array(z.string().min(1).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..") && !/[\x00-\x1f*?\[\]:]/.test(p), "expected a literal repository-relative path")).min(1).optional(),
  /** Registry-backed BuildKit cache is enabled by default; false disables it. */
  cache: z.boolean({ error: "expected boolean" }).optional(),
  /** Signed GitHub pushes trigger an OCD build and full manifest reconcile. */
  webhook: z.boolean({ error: "expected boolean" }).optional(),
}, { error: "expected object { repository, dockerfile, context, image_repository, platform?, cache?, webhook? }" }).strict().superRefine((value, ctx) => {
  for (const [key, path] of [["dockerfile", value.dockerfile], ["context", value.context]] as const) {
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\\")) {
      ctx.addIssue({ code: "custom", path: [key], message: "must be a safe repository-relative path" });
    }
  }
});

/** Exact runtime variables: literal strings or explicit resource references. */
export const RuntimeEnvSchema = z.record(
  z.string().regex(ENV_KEY_PATTERN, "expected env-var-name key"),
  z.union([
    z.string(),
    z.object({ from: z.string().regex(
      /^(?:environment\.[A-Za-z_][A-Za-z0-9_]*|apps\.[a-z0-9][a-z0-9-]*\.outputs\.[A-Za-z_][A-Za-z0-9_]*)$/,
      "expected environment.KEY or apps.MEMBER.outputs.KEY",
    ) }).strict(),
  ]),
);
export const RuntimeOutputsSchema = z.record(
  z.string().regex(ENV_KEY_PATTERN, "expected output name"),
  z.object({
    template: nonEmptyString("expected a non-empty template string").refine(
      (value) => !value.replace(/\{(?:app\.(?:host|port)|env\.[A-Za-z_][A-Za-z0-9_]*)\}/g, "").match(/[{}]/),
      "templates accept only {app.host}, {app.port}, and {env.KEY}",
    ),
    secret: z.boolean().optional(),
  }).strict(),
);
export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>;
export type RuntimeOutputs = z.infer<typeof RuntimeOutputsSchema>;

const commandSchema = z.array(
  nonEmptyString("expected a non-empty command argument"),
  { error: "expected an array of command arguments" },
).min(1, { error: "expected at least one command argument" });

const CAPABILITY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** App data volume desired state. `id` adopts one exact retained/provider
 * volume; omitting it means OCD owns creation. Size is always explicit so the
 * reconciler can grow deterministically and reject impossible shrink requests. */
const volumeSchema = z.object(
  {
    driver: nonEmptyString("expected a storage driver id").optional(),
    id: nonEmptyString("expected a non-empty provider volume id").optional(),
    size: guardedNumber("expected positive integer", (v) => Number.isInteger(v) && v >= 1),
    path: z
      .string({ error: 'expected string starting with "/"' })
      .refine((v) => v.startsWith("/"), {
        error: (iss) => `expected string starting with "/", got ${got(iss.input)}`,
      })
      .optional(),
  },
  { error: "expected object { size, id?, path? }" },
);

/**
 * HTTP health check. `enabled:false` skips the HTTP probe and only verifies the
 * container runs (default true). `path` is the endpoint both the post-deploy
 * probe and Traefik's rotation check request (default /; setting one also turns
 * on Traefik's continuous check). A path requires internal_protocol 'http'.
 *
 * NOTE: the object form `{ enabled?, path? }` is the ONLY form honored by the
 * mapping — a bare boolean (the original incident) is a hard error here.
 */
const healthCheckSchema = z.object(
  {
    enabled: z.boolean({ error: "expected boolean" }).optional(),
    path: z.string({ error: "expected string" }).optional(),
    /** Readiness contract. Omit for the legacy enabled/path behavior. */
    mode: z.enum(["http", "container", "exec", "heartbeat"], {
      error: 'expected "http" | "container" | "exec" | "heartbeat"',
    }).optional(),
    /** Shell command executed inside the container for mode=exec. Exit 0=ready. */
    command: nonEmptyString("expected a non-empty string").optional(),
    /** Absolute timestamp-marker path for heartbeat mode. */
    file: z.string({ error: 'expected absolute path string' }).refine((v) => /^\/[A-Za-z0-9._/-]+$/.test(v), {
      error: (iss) => `expected absolute path string, got ${got(iss.input)}`,
    }).optional(),
    /** Maximum marker age before readiness fails. */
    max_age_seconds: guardedNumber(
      "expected positive integer",
      (v) => Number.isInteger(v) && v >= 1,
    ).optional(),
    /** Exact HTTP statuses accepted by readiness. Defaults to [200]. */
    expected_statuses: z.array(
      guardedNumber("expected integer HTTP status 100-599", (v) => Number.isInteger(v) && v >= 100 && v <= 599),
      { error: "expected array of HTTP status codes" },
    ).min(1, { error: "expected at least one HTTP status code" }).optional(),
  },
  { error: "expected health-check object" },
).superRefine((value, ctx) => {
  const mode = value.mode ?? (value.enabled === false ? "container" : "http");
  if (mode === "exec" && !value.command) {
    ctx.addIssue({ code: "custom", message: "required when mode is exec", path: ["command"] });
  }
  if (mode === "heartbeat" && !value.file) {
    ctx.addIssue({ code: "custom", message: "required when mode is heartbeat", path: ["file"] });
  }
  if (mode === "heartbeat" && !value.max_age_seconds) {
    ctx.addIssue({ code: "custom", message: "required when mode is heartbeat", path: ["max_age_seconds"] });
  }
  if (value.mode && mode !== "http" && value.path) {
    ctx.addIssue({ code: "custom", message: "only valid when mode is http", path: ["path"] });
  }
  if (mode !== "http" && value.expected_statuses) {
    ctx.addIssue({ code: "custom", message: "only valid when mode is http", path: ["expected_statuses"] });
  }
});

/** Explicit per-server placement: server name or numeric id -> replica count. */
const placementSchema = z.record(
  nonEmptyString("expected a server name"),
  guardedNumber("expected positive integer replica count", (v) => Number.isInteger(v) && v >= 1),
  { error: 'expected object { "<server name>": <replicas>, ... }' },
).refine((value) => Object.keys(value).length > 0, { error: "expected at least one server" });

export const DeployManifestSchema = z
  .object({
    $schema: z.literal(1, { error: "expected 1" }).optional(),
    /** Recognized metadata for agent/tooling hints; ignored by the deploy engine. */
    $llm: z.unknown().optional(),
    name: nonEmptyString("expected a non-empty string"),
    description: z.string({ error: "expected string" }).optional(),
    icon: z.string({ error: "expected string" }).optional(),
    /** OCD-owned source checkout and BuildKit delivery contract. Mutually
     * exclusive with image. */
    build: buildSchema.optional(),
    /** Prebuilt OCI image reference. Tags are accepted as manifest intent but
     * are resolved to an immutable digest before desired state is changed. */
    image: nonEmptyString("expected an OCI image reference").optional(),
    container_port: guardedNumber(
      "expected integer 1-65535",
      (v) => Number.isInteger(v) && v >= 1 && v <= 65535,
    ).optional(),
    env: RuntimeEnvSchema.optional(),
    storage: StorageBindingsSchema.optional(),
    notifications: NtfyBindingsSchema.optional(),
    outputs: RuntimeOutputsSchema.optional(),
    /** Existing environment selected by name; null explicitly detaches it. */
    environment: z.union([
      nonEmptyString("expected a non-empty environment name"),
      z.null(),
    ]).optional(),
    /** Required: null explicitly means no primary volume. */
    volume: z.union([volumeSchema, z.null()], {
      error: "expected null or object { size, id?, path? }",
    }),
    suggested_app_name: z.string({ error: "expected string" }).optional(),
    /** Custom public domain. */
    domain: z.string({ error: "expected string" }).optional(),
    /** Required explicit placement: server name (or numeric id) -> replica count. */
    placement: placementSchema,
    public: z.boolean({ error: "expected boolean" }).optional(),
    /** Per-container memory ceiling in MB. Omit / 0 → platform default. */
    memory_mb: guardedNumber(
      `expected integer 0 (default) or ${MIN_MEMORY_MB}-${MAX_MEMORY_MB}`,
      isValidMemoryMb,
    ).optional(),
    /** Per-container CPU ceiling in cores (fractional allowed). Omit / 0 → platform default. */
    cpu_limit: guardedNumber(
      `expected 0 (default) or a number ${MIN_CPU_LIMIT}-${MAX_CPU_LIMIT}`,
      isValidCpuLimit,
    ).optional(),
    /** Optional image command override, passed as argv after the image. */
    command: commandSchema.optional(),
    /** Explicit capabilities restored after the platform-wide cap drop. */
    cap_add: z.array(
      z.string().refine((capability) => CAPABILITY_PATTERN.test(capability), {
        error: "expected uppercase Linux capability name",
      }),
      { error: "expected an array of Linux capability names" },
    ).optional(),
    health_check: healthCheckSchema.optional(),
    /** Internal routing protocol (independent of health_check.enabled); omit → "http".
     *  Raw-TCP apps (e.g. databases) must set "tcp". */
    internal_protocol: z.enum(["http", "tcp"], { error: 'expected "http" | "tcp"' }).optional(),
    /** Public-router rate limit in req/s; omit / 0 = unlimited. */
    rate_limit_rps: guardedNumber(
      "expected integer 0 (unlimited) to 1000000",
      isValidRateLimitRps,
    ).optional(),
    /** Response compression on the public router. */
    compress: z.boolean({ error: "expected boolean" }).optional(),
    /** Ports opened to the internet on every placed server. Declaring any runs
     * the app on the host network, one replica per server. */
    public_ports: PublicPortsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.build) === Boolean(value.image)) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of build or image is required",
        path: value.build ? ["image"] : ["build"],
      });
    }
    if (value.volume && value.placement) {
      const error = volumePlacementError(value.placement);
      if (error) ctx.addIssue({ code: "custom", message: error, path: ["placement"] });
    }
    const healthMode = value.health_check?.mode ?? (value.health_check?.enabled === false ? "container" : "http");
    for (const { field, message } of publicPortsAppErrors({
      public_ports: value.public_ports,
      placement: value.placement,
      health_check_mode: healthMode,
    })) {
      ctx.addIssue({ code: "custom", message, path: [field] });
    }
  });

export type DeployManifest = z.infer<typeof DeployManifestSchema>;

// --- stack manifest ---------------------------------------------------------

/** One app member: a path to a child `.ocd-deploy.json` + stack-level overrides. */
const stackAppSchema = z
  .object({
    manifest: nonEmptyString("expected a manifest path string"),
    needs: z
      .array(z.string({ error: "expected a key string" }), {
        error: "expected array of app keys",
      })
      .optional(),
    domain: z.string({ error: "expected string" }).optional(),
    public: z.boolean({ error: "expected boolean" }).optional(),
    /** Replaces the child manifest's placement for this stack member. */
    placement: placementSchema.optional(),
  }, { error: "expected object { manifest, needs?, domain?, public?, placement? }" })
  .strict();

export const StackManifestSchema = z
  .object({
    $schema: z.literal(1, { error: "expected 1" }).optional(),
    /** Recognized metadata for agent/tooling hints; ignored by the deploy engine. */
    $llm: z.unknown().optional(),
    name: nonEmptyString("expected a non-empty string"),
    description: z.string({ error: "expected string" }).optional(),
    /** Lower numbers reconcile first in repository releases. */
    release_order: z.number().int().optional(),
    /** Existing shared production environment selected by name. */
    environment: nonEmptyString("expected a non-empty environment name").optional(),
    apps: z.record(z.string(), stackAppSchema, { error: "expected object map of key -> app" }),
  })
  .strict()
  .superRefine((val, ctx) => {
    // apps must be non-empty.
    const appKeys = Object.keys(val.apps ?? {});
    if (appKeys.length === 0) {
      ctx.addIssue({ code: "custom", message: "expected at least one app", path: ["apps"] });
    }
    // Cross-field: every `needs` entry must name a declared app key.
    const known = new Set(appKeys);
    for (const [key, app] of Object.entries(val.apps ?? {})) {
      const needs = app.needs ?? [];
      for (let i = 0; i < needs.length; i++) {
        const n = needs[i];
        if (!known.has(n)) {
          ctx.addIssue({
            code: "custom",
            message: `references "${n}", which is not a declared app key`,
            path: ["apps", key, "needs", i],
          });
        }
      }
    }
  });

export type StackManifest = z.infer<typeof StackManifestSchema>;
