import { describe, test, expect } from "bun:test";
import {
  validateAppName,
  validateDomain,
  validatePort,
  validateEnvVars,
  validateHetznerToken,
  validateDeployRequest,
  validateGitHubPat,
  validateDeployManifest as validateDeployManifestRaw,
  assertSafeHostPath,
  validateHealthCheckPath,
  validateIngressFields,
} from "./validate.ts";

const TEST_BUILD = {
  repository: "https://github.com/acme/test",
  branch: "main",
  dockerfile: "Dockerfile",
  context: ".",
  image_repository: "ghcr.io/acme/test",
  webhook: true,
} as const;
const validateDeployManifest = (raw: unknown) => validateDeployManifestRaw(
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? { build: TEST_BUILD, ...raw }
    : raw,
);

describe("assertSafeHostPath", () => {
  test("accepts provisioned local volumes only for the exact app and operation", () => {
    expect(() => assertSafeHostPath("/var/lib/ocd/volumes/ocd-myapp-op3575", "myapp")).not.toThrow();
    expect(() => assertSafeHostPath("/var/lib/ocd/volumes/ocd-myapp-op3575/data", "myapp")).not.toThrow();
    expect(() => assertSafeHostPath("/var/lib/ocd/volumes/ocd-other-op3575", "myapp")).toThrow(/allowlist/);
    expect(() => assertSafeHostPath("/var/lib/ocd/volumes/ocd-myapp-op3575-op9", "myapp")).toThrow(/allowlist/);
  });
  test("accepts per-app volume root", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/myapp/volumes/data", "myapp")).not.toThrow();
  });
  test("accepts block-storage prefix", () => {
    expect(() => assertSafeHostPath("/mnt/ocd-myapp-data", "myapp")).not.toThrow();
  });
  test("accepts per-service volume root", () => {
    expect(() => assertSafeHostPath("/home/deploy/services/postgres/data", "postgres")).not.toThrow();
  });
  test("rejects /etc", () => {
    expect(() => assertSafeHostPath("/etc/passwd", "myapp")).toThrow(/allowlist/);
  });
  test("rejects another app's dir", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/other/volumes/data", "myapp")).toThrow(/allowlist/);
  });
  test("rejects ..", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/myapp/volumes/../../../etc", "myapp")).toThrow(/'\.\.'/);
  });
  test("rejects relative paths", () => {
    expect(() => assertSafeHostPath("relative/path", "myapp")).toThrow(/absolute/);
  });
  test("rejects whitespace / injection chars", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/myapp/volumes/x y", "myapp")).toThrow(/invalid/);
  });
  test("rejects unsafe app name", () => {
    expect(() => assertSafeHostPath("/home/deploy/apps/x/volumes/data", "../etc")).toThrow(/Invalid app name/);
  });
});

describe("validateAppName", () => {
  test("accepts valid names", () => {
    expect(validateAppName("my-app").valid).toBe(true);
    expect(validateAppName("app123").valid).toBe(true);
    expect(validateAppName("a").valid).toBe(true);
    expect(validateAppName("a1").valid).toBe(true);
  });

  test("trims and lowercases", () => {
    const result = validateAppName("  My-App  ");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe("my-app");
  });

  test("rejects empty", () => {
    expect(validateAppName("").valid).toBe(false);
    expect(validateAppName("   ").valid).toBe(false);
  });

  test("rejects names longer than 63 chars", () => {
    expect(validateAppName("a".repeat(64)).valid).toBe(false);
  });

  test("rejects names starting/ending with hyphen", () => {
    expect(validateAppName("-app").valid).toBe(false);
    expect(validateAppName("app-").valid).toBe(false);
  });

  test("rejects consecutive hyphens", () => {
    expect(validateAppName("my--app").valid).toBe(false);
  });

  test("rejects special characters", () => {
    expect(validateAppName("my_app").valid).toBe(false);
    expect(validateAppName("my app").valid).toBe(false);
    expect(validateAppName("my.app").valid).toBe(false);
  });
});

describe("validateDomain", () => {
  test("accepts valid domains", () => {
    expect(validateDomain("example.com").valid).toBe(true);
    expect(validateDomain("sub.example.com").valid).toBe(true);
    expect(validateDomain("my-app.example.co.uk").valid).toBe(true);
  });

  test("lowercases", () => {
    const result = validateDomain("Example.COM");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe("example.com");
  });

  test("rejects single label", () => {
    expect(validateDomain("localhost").valid).toBe(false);
  });

  test("rejects empty labels", () => {
    expect(validateDomain("example..com").valid).toBe(false);
  });

  test("rejects labels over 63 chars", () => {
    expect(validateDomain("a".repeat(64) + ".com").valid).toBe(false);
  });

  test("rejects domains over 253 chars", () => {
    const long = Array(30).fill("abcdefghij").join(".") + ".com";
    expect(validateDomain(long).valid).toBe(false);
  });

  test("rejects labels with special chars", () => {
    expect(validateDomain("my_app.com").valid).toBe(false);
    expect(validateDomain("my app.com").valid).toBe(false);
  });
});

describe("validatePort", () => {
  test("accepts valid ports", () => {
    expect(validatePort(80).valid).toBe(true);
    expect(validatePort(3000).valid).toBe(true);
    expect(validatePort(65535).valid).toBe(true);
    expect(validatePort(1).valid).toBe(true);
  });

  test("rejects out of range", () => {
    expect(validatePort(0).valid).toBe(false);
    expect(validatePort(-1).valid).toBe(false);
    expect(validatePort(65536).valid).toBe(false);
  });

  test("rejects non-integers", () => {
    expect(validatePort(3.14).valid).toBe(false);
  });
});

describe("validateEnvVars", () => {
  test("accepts valid env vars", () => {
    expect(validateEnvVars({ NODE_ENV: "production", PORT: "3000" }).valid).toBe(true);
    expect(validateEnvVars({ _VAR: "value" }).valid).toBe(true);
    expect(validateEnvVars({}).valid).toBe(true);
  });

  test("rejects invalid key format", () => {
    expect(validateEnvVars({ "123": "val" }).valid).toBe(false);
    expect(validateEnvVars({ "key with spaces": "val" }).valid).toBe(false);
    expect(validateEnvVars({ "key-with-dash": "val" }).valid).toBe(false);
  });

  test("rejects reserved prefixes", () => {
    expect(validateEnvVars({ PATH: "val" }).valid).toBe(false);
    expect(validateEnvVars({ HOME: "val" }).valid).toBe(false);
    expect(validateEnvVars({ DOCKER_HOST: "val" }).valid).toBe(false);
    expect(validateEnvVars({ LD_PRELOAD: "val" }).valid).toBe(false);
  });

  test("rejects null bytes in values", () => {
    expect(validateEnvVars({ KEY: "val\0ue" }).valid).toBe(false);
  });
});

describe("validateHetznerToken", () => {
  test("accepts valid tokens", () => {
    expect(validateHetznerToken("a".repeat(32)).valid).toBe(true);
    expect(validateHetznerToken("a".repeat(64)).valid).toBe(true);
    expect(validateHetznerToken("a".repeat(128)).valid).toBe(true);
  });

  test("rejects empty", () => {
    expect(validateHetznerToken("").valid).toBe(false);
  });

  test("rejects too short", () => {
    expect(validateHetznerToken("short").valid).toBe(false);
  });

  test("rejects too long", () => {
    expect(validateHetznerToken("a".repeat(129)).valid).toBe(false);
  });

  test("rejects non-printable characters", () => {
    expect(validateHetznerToken("a".repeat(31) + "\x01").valid).toBe(false);
  });
});

describe("validateDeployRequest", () => {
  const validRequest = {
    app_name: "my-app",
    image_ref: `ghcr.io/acme/my-app@sha256:${"a".repeat(64)}`,
    container_port: 3000,
    env: { NODE_ENV: "production" },
    placement: { "server-2": 1 },
  };

  test("accepts valid request", () => {
    expect(validateDeployRequest(validRequest).valid).toBe(true);
  });

  test("accepts with optional domain", () => {
    expect(validateDeployRequest({ ...validRequest, domain: "app.example.com" }).valid).toBe(true);
  });

  test("rejects invalid app name", () => {
    expect(validateDeployRequest({ ...validRequest, app_name: "" }).valid).toBe(false);
  });

  test("rejects a mutable image tag", () => {
    expect(validateDeployRequest({ ...validRequest, image_ref: "ghcr.io/acme/my-app:latest" }).valid).toBe(false);
  });

  test("rejects malformed provenance commits", () => {
    expect(validateDeployRequest({ ...validRequest, git_commit: "not-a-sha" }).valid).toBe(false);
  });

  test("rejects invalid port", () => {
    expect(validateDeployRequest({ ...validRequest, container_port: 0 }).valid).toBe(false);
  });

  test("rejects invalid env vars", () => {
    expect(validateDeployRequest({ ...validRequest, env: { KEY: { from: "invalid.KEY" } } }).valid).toBe(false);
  });

  test("rejects invalid domain", () => {
    expect(validateDeployRequest({ ...validRequest, domain: "not valid" }).valid).toBe(false);
  });

  test("accepts memory_mb of 0 (platform default)", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 0 }).valid).toBe(true);
  });

  test("accepts memory_mb within bounds", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 1024 }).valid).toBe(true);
  });

  test("rejects memory_mb below minimum", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 64 }).valid).toBe(false);
  });

  test("rejects non-integer memory_mb", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 512.5 }).valid).toBe(false);
  });

  test("rejects memory_mb above maximum", () => {
    expect(validateDeployRequest({ ...validRequest, memory_mb: 99999 }).valid).toBe(false);
  });

  test("accepts cpu_limit of 0 (platform default)", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0 }).valid).toBe(true);
  });

  test("accepts fractional cpu_limit within bounds", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0.5 }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 2 }).valid).toBe(true);
  });

  test("rejects cpu_limit below minimum", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0.05 }).valid).toBe(false);
  });

  test("rejects cpu_limit above maximum", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 64 }).valid).toBe(false);
  });

  test("rejects cpu_limit with nonsense precision", () => {
    expect(validateDeployRequest({ ...validRequest, cpu_limit: 0.333333 }).valid).toBe(false);
  });

  test("internal_protocol must be http or tcp", () => {
    expect(validateDeployRequest({ ...validRequest, internal_protocol: "http" }).valid).toBe(true);
    expect(validateDeployRequest({ ...validRequest, internal_protocol: "tcp" }).valid).toBe(true);
    const r = validateDeployRequest({ ...validRequest, internal_protocol: "grpc" as any });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/internal protocol must be/i);
  });

  test("rejects a private app with a domain", () => {
    const r = validateDeployRequest({ ...validRequest, public: false, domain: "app.example.com" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/private apps cannot have a public domain/i);
  });

  test("accepts a private app without a domain", () => {
    expect(validateDeployRequest({ ...validRequest, public: false }).valid).toBe(true);
  });

  test("accepts the per-app ingress settings when valid", () => {
    expect(validateDeployRequest({
      ...validRequest,
      rate_limit_rps: 100,
      health_check_path: "/healthz",
      compress: true,
    }).valid).toBe(true);
  });

  test("rejects a bad rate limit (negative / non-integer)", () => {
    expect(validateDeployRequest({ ...validRequest, rate_limit_rps: -1 }).valid).toBe(false);
    expect(validateDeployRequest({ ...validRequest, rate_limit_rps: 1.5 }).valid).toBe(false);
  });

  test("rejects a health check path that doesn't start with /", () => {
    const r = validateDeployRequest({ ...validRequest, health_check_path: "healthz" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toMatch(/must start with/i);
  });

  test("rejects health_check_path on a raw-TCP app (internal_protocol: tcp)", () => {
    expect(validateDeployRequest({ ...validRequest, health_check_path: "/healthz", internal_protocol: "tcp" }).valid).toBe(false);
  });


  test("validates public ports with the manifest rules", () => {
    const hostNetwork = {
      ...validRequest,
      health_check_mode: "container",
      public_ports: [{ port: 3478, protocol: "udp" as const }, { port: "49160-49999", protocol: "udp" as const }],
    };
    expect(validateDeployRequest(hostNetwork).valid).toBe(true);
    const badRange = validateDeployRequest({ ...hostNetwork, public_ports: [{ port: "9-1", protocol: "udp" as const }] });
    expect(badRange.valid ? "" : badRange.error).toContain("public_ports[0].port");
    const replicas = validateDeployRequest({ ...hostNetwork, placement: { "server-2": 2 } });
    expect(replicas.valid ? "" : replicas.error).toContain("exactly 1 replica");
    const http = validateDeployRequest({ ...hostNetwork, health_check_mode: undefined });
    expect(http.valid ? "" : http.error).toContain("health_check.mode");
  });
});

describe("validateHealthCheckPath", () => {
  test("accepts an absolute path and trims it", () => {
    expect(validateHealthCheckPath(" /healthz ")).toEqual({ valid: true, value: "/healthz" });
    expect(validateHealthCheckPath("/api/v1/health?deep=1").valid).toBe(true);
  });

  test("empty means disabled", () => {
    expect(validateHealthCheckPath("")).toEqual({ valid: true, value: "" });
  });

  test("rejects relative paths and embedded whitespace", () => {
    expect(validateHealthCheckPath("healthz").valid).toBe(false);
    expect(validateHealthCheckPath("/health z").valid).toBe(false);
  });

  test("rejects overlong paths", () => {
    expect(validateHealthCheckPath("/" + "a".repeat(200)).valid).toBe(false);
  });
});

describe("validateGitHubPat", () => {
  test("accepts a realistic-shaped classic PAT (40 hex chars)", () => {
    const r = validateGitHubPat("a".repeat(40));
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value).toBe("a".repeat(40));
  });

  test("accepts a fine-grained token with underscores (github_pat_... form)", () => {
    const tok = "github_pat_" + "A".repeat(22) + "_" + "B".repeat(59);
    expect(validateGitHubPat(tok).valid).toBe(true);
  });

  test("trims surrounding whitespace", () => {
    const r = validateGitHubPat("   " + "x".repeat(40) + "  ");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.value).toBe("x".repeat(40));
  });

  test("rejects empty", () => {
    expect(validateGitHubPat("").valid).toBe(false);
    expect(validateGitHubPat("   ").valid).toBe(false);
  });

  test("rejects too short (<30 chars)", () => {
    expect(validateGitHubPat("x".repeat(29)).valid).toBe(false);
  });

  test("rejects too long (>256 chars)", () => {
    expect(validateGitHubPat("x".repeat(257)).valid).toBe(false);
  });

  test("rejects embedded non-printable chars (NUL, tab)", () => {
    expect(validateGitHubPat("x".repeat(20) + "\0" + "x".repeat(20)).valid).toBe(false);
    expect(validateGitHubPat("x".repeat(20) + "\t" + "x".repeat(20)).valid).toBe(false);
  });
});

describe("validateDeployManifest", () => {
  test("accepts a minimal manifest with explicit no-volume state", () => {
    const r = validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "demo" });
    expect(r.ok).toBe(true);
  });

  test("requires a source build contract", () => {
    expect(validateDeployManifestRaw({ volume: null, placement: { "server-2": 1 }, name: "demo" }).ok).toBe(false);
    expect(validateDeployManifestRaw({
      volume: null, placement: { "server-2": 1 },
      name: "demo",
      build: { ...TEST_BUILD, image_repository: "ghcr.io/acme/demo:latest" },
    }).ok).toBe(false);
  });

  test("accepts a full manifest", () => {
    const r = validateDeployManifest({
      $schema: 1,
      name: "app",
      description: "desc",
      container_port: 3000,
      env: { DATABASE_URL: { from: "environment.DATABASE_URL" }, API_KEY: { from: "environment.API_KEY" } },
      volume: { size: 5, path: "/data" },
      placement: { "server-2": 1 },
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-object raw inputs", () => {
    expect(validateDeployManifest(null).ok).toBe(false);
    expect(validateDeployManifest([]).ok).toBe(false);
    expect(validateDeployManifest("string").ok).toBe(false);
  });

  test("rejects missing / empty name", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 } }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "" }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "   " }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: 42 }).ok).toBe(false);
  });

  test("rejects wrong $schema version", () => {
    const r = validateDeployManifest({ volume: null, placement: { "server-2": 1 }, $schema: 2, name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/schema/i);
  });

  test("accepts a valid memory_mb", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", memory_mb: 2048 }).ok).toBe(true);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", memory_mb: 0 }).ok).toBe(true);
  });

  test("rejects an out-of-range memory_mb", () => {
    const r = validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", memory_mb: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/memory_mb/);
  });

  test("rejects non-integer container_port", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", container_port: 3.14 }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", container_port: 0 }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", container_port: 99999 }).ok).toBe(false);
  });

  test("rejects env entries with invalid keys", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", env: [{ key: "1BAD" }] }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", env: [{ key: "has-dash" }] }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", env: "not-an-array" }).ok).toBe(false);
  });

  test("rejects volume with invalid size / non-absolute path", () => {
    expect(validateDeployManifest({ name: "x", volume: { size: 0 } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", volume: { size: -1 } }).ok).toBe(false);
    expect(validateDeployManifest({ name: "x", volume: { path: "data" } }).ok).toBe(false);
  });

  test("requires explicit volume state", () => {
    const r = validateDeployManifest({ name: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/volume/);
  });

  test("rejects an empty placement or a non-positive replica count", () => {
    expect(validateDeployManifest({ volume: null, name: "x", placement: {} }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, name: "x", placement: { "server-2": 0 } }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, name: "x", placement: { "server-2": 1.5 } }).ok).toBe(false);
  });

  test("accepts a full ingress manifest", () => {
    const r = validateDeployManifest({
      name: "x",
      volume: null, placement: { "server-2": 1 },
      internal_protocol: "http",
      rate_limit_rps: 100,
      health_check: { enabled: true, path: "/healthz" },
      compress: true,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-boolean compress", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", compress: 1 }).ok).toBe(false);
  });

  test("rejects an invalid rate_limit_rps / health_check.path", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", rate_limit_rps: -1 }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: { path: "healthz" } }).ok).toBe(false);
  });

  test("rejects a malformed health_check object", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: true }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: { enabled: "yes" } }).ok).toBe(false);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: { path: 1 } }).ok).toBe(false);
  });

  test("accepts a nested health_check with enabled and path", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: { enabled: false } }).ok).toBe(true);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: { path: "/healthz" } }).ok).toBe(true);
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: {} }).ok).toBe(true);
  });

  test("rejects health_check.path on a raw-TCP manifest", () => {
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", internal_protocol: "tcp", health_check: { path: "/healthz" } }).ok).toBe(false);
    // Decoupled: enabled:false no longer implies tcp routing (defaults to http),
    // so a path alongside a disabled probe is accepted at the routing rule.
    expect(validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "x", health_check: { enabled: false, path: "/healthz" } }).ok).toBe(true);
  });

});

describe("validateIngressFields (shared by deploy + ingress endpoint)", () => {
  test("normalizes health path, passes through rate limit", () => {
    const r = validateIngressFields(
      { health_check_path: " /healthz ", rate_limit_rps: 100 },
      { httpRouted: true },
    );
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.value.health_check_path).toBe("/healthz");
      expect(r.value.rate_limit_rps).toBe(100);
    }
  });

  test("health path requires HTTP routing (httpRouted=false rejects)", () => {
    expect(validateIngressFields({ health_check_path: "/healthz" }, { httpRouted: false }).valid).toBe(false);
    // An empty value doesn't trip the gate.
    expect(validateIngressFields({ health_check_path: "" }, { httpRouted: false }).valid).toBe(true);
  });

  test("deploy and ingress agree: same rule yields the same error string", () => {
    const viaDeploy = validateDeployRequest({
      app_name: "a", image_ref: `ghcr.io/acme/a@sha256:${"a".repeat(64)}`, container_port: 3000,
      health_check_path: "/healthz", internal_protocol: "tcp", placement: { "server-2": 1 },
    });
    const viaHelper = validateIngressFields({ health_check_path: "/healthz" }, { httpRouted: false });
    expect(viaDeploy.valid).toBe(false);
    expect(viaHelper.valid).toBe(false);
    if (!viaDeploy.valid && !viaHelper.valid) expect(viaDeploy.error).toBe(viaHelper.error);
  });

});
