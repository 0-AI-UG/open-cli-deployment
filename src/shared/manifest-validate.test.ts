import { describe, test, expect, spyOn } from "bun:test";
import { validateDeployManifest, validateStackManifest } from "./manifest-validate.ts";
import type { DeployManifest, StackManifest } from "./rpc.ts";

// Compile-time guard: the `z.infer`-derived types must stay structurally
// compatible with how the rest of the codebase reads a manifest (e.g.
// stack-spec.ts reads health_check?.enabled and container_port). If the
// schema drifts from these shapes, this file stops type-checking.
const BUILD = {
  repository: "https://github.com/acme/web",
  branch: "main",
  dockerfile: "Dockerfile",
  context: ".",
  image_repository: "ghcr.io/acme/web",
  webhook: true,
} as const;
const _deploy: DeployManifest = {
  name: "web",
  build: BUILD,
  container_port: 3000,
  env: { PORT: "3000" },
  volume: { size: 5, path: "/data" },
  health_check: { enabled: false, path: "/healthz" },
  internal_protocol: "http",
  domain: "web.example.com",
  environment: "production",
  placement: { "server-2": 1 },
};
const _enabled: boolean | undefined = _deploy.health_check?.enabled;
const _port: number | undefined = _deploy.container_port;
const _stack: StackManifest = {
  name: "s",
  apps: { web: { manifest: "web/.ocd-deploy.json" } },
};
void _enabled;
void _port;
void _stack;

const validApp = {
  name: "web",
  volume: null, placement: { "server-2": 1 },
  build: BUILD,
  container_port: 3000,
  env: { PORT: "3000" },
  health_check: { enabled: false },
  internal_protocol: "http" as const,
};

describe("validateDeployManifest", () => {
  test("accepts arbitrary image apps and rejects ambiguous delivery sources", () => {
    expect(() => validateDeployManifest({
      name: "database",
      image: "postgres:17-alpine",
      container_port: 5432,
      volume: { size: 10, path: "/var/lib/postgresql/data" },
      placement: { "server-2": 1 },
      env: { POSTGRES_PASSWORD: { from: "environment.POSTGRES_PASSWORD" } },
      outputs: {
        URL: { template: "postgresql://postgres:{env.POSTGRES_PASSWORD}@{app.host}:{app.port}/postgres", secret: true },
      },
      cap_add: ["CHOWN", "SETUID", "SETGID"],
    }, ".ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      name: "database",
      image: { ref: "postgres:17-alpine" },
      volume: null, placement: { "server-2": 1 },
    }, ".ocd-deploy.json")).toThrow("expected an OCI image reference");
    expect(() => validateDeployManifest({ ...validApp, image: "nginx:alpine" }, ".ocd-deploy.json"))
      .toThrow("exactly one of build or image");
    const { build: _build, ...withoutSource } = validApp;
    expect(() => validateDeployManifest(withoutSource, ".ocd-deploy.json"))
      .toThrow("exactly one of build or image");
  });

  test("accepts recognized $llm metadata without warnings", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateDeployManifest({ ...validApp, $llm: { purpose: "worker" } }, ".ocd-deploy.json")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("validates exact HTTP readiness statuses", () => {
    expect(() => validateDeployManifest({
      ...validApp,
      health_check: { mode: "http", path: "/ready", expected_statuses: [200, 204] },
    }, ".ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      ...validApp,
      health_check: { mode: "http", expected_statuses: [700] },
    }, ".ocd-deploy.json")).toThrow();
  });
  test("accepts safe OCD build contracts and rejects tagged push repositories", () => {
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, placement: { "server-2": 1 }, build: { ...BUILD, image_repository: "ghcr.io/acme/worker" } },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, placement: { "server-2": 1 }, build: { ...BUILD, image_repository: "ghcr.io/acme/worker:latest" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
  });

  test("pins the supported build platform and allows an explicit cache opt-out", () => {
    expect(() => validateDeployManifest({
      name: "worker",
      volume: null, placement: { "server-2": 1 },
      build: { ...BUILD, platform: "linux/amd64", cache: false },
    }, ".ocd-deploy.json")).not.toThrow();
    expect(() => validateDeployManifest({
      name: "worker",
      volume: null, placement: { "server-2": 1 },
      build: { ...BUILD, platform: "linux/arm64" },
    }, ".ocd-deploy.json")).toThrow("linux/amd64");
  });

  test("validates truthful worker and job health contracts", () => {
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, placement: { "server-2": 1 }, build: BUILD, health_check: { mode: "exec", command: "test -f /tmp/ready" } },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "worker", volume: null, placement: { "server-2": 1 }, health_check: { mode: "exec" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
    expect(() =>
      validateDeployManifest(
        {
          name: "cron",
          volume: null, placement: { "server-2": 1 },
          build: BUILD,
          health_check: {
            mode: "heartbeat",
            file: "/run/last-success",
            max_age_seconds: 3600,
          },
        },
        ".ocd-deploy.json",
      ),
    ).not.toThrow();
    expect(() =>
      validateDeployManifest(
        { name: "cron", volume: null, placement: { "server-2": 1 }, health_check: { mode: "heartbeat", file: "/run/last-success" } },
        ".ocd-deploy.json",
      ),
    ).toThrow();
    expect(() =>
      validateDeployManifest(
        {
          name: "cron",
          volume: null, placement: { "server-2": 1 },
          build: BUILD,
          health_check: { mode: "periodic_job", file: "/run/last-success", max_age_seconds: 3600 },
        },
        ".ocd-deploy.json",
      ),
    ).toThrow(/health_check\.mode/);
  });
  test("a correct manifest passes", () => {
    expect(() => validateDeployManifest(validApp, "docker/.ocd-deploy.json")).not.toThrow();
  });

  test("health_check boolean (the incident) fails with a clear message", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "db", health_check: false }, "docker/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("docker/.ocd-deploy.json");
    expect(msg).toContain("health_check: expected health-check object, got boolean (false)");
  });

  test("bad internal_protocol enum fails", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", internal_protocol: "tpc" }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('internal_protocol: expected "http" | "tcp", got "tpc"');
  });

  test("missing name fails", () => {
    expect(() => validateDeployManifest({ volume: null, placement: { "server-2": 1 } }, "a/.ocd-deploy.json")).toThrow(/name:/);
  });

  test("collects multiple issues at once", () => {
    let msg = "";
    try {
      validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", public: "yes", health_check: false }, "a/.ocd-deploy.json");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("public: expected boolean, got \"yes\"");
    expect(msg).toContain("health_check: expected health-check object");
  });

  test("wrong-typed container_port fails", () => {
    expect(() => validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", build: BUILD, container_port: "3000" }, "a")).toThrow(
      /container_port: expected integer 1-65535, got "3000"/,
    );
  });

  test("unknown key fails by default", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", futureField: 1 }, "a/.ocd-deploy.json"))
      .toThrow(/futureField: unknown key/);
    expect(warn).not.toHaveBeenCalled();
    expect(() => validateDeployManifest(
      { volume: null, placement: { "server-2": 1 }, name: "web", build: BUILD, futureField: 1 },
      "a/.ocd-deploy.json",
      { allowUnknown: true },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Manifest a/.ocd-deploy.json: unknown key "futureField" (ignored by --allow-unknown)',
    );
    warn.mockRestore();
  });

  test("placement is required and maps servers to positive replica counts", () => {
    expect(() =>
      validateDeployManifest({ volume: null, placement: { "server-2": 1, "sight-capacity-1": 2, "7": 1 }, name: "web", build: BUILD }, "a/.ocd-deploy.json"),
    ).not.toThrow();
    expect(() => validateDeployManifest({ volume: null, name: "web", build: BUILD }, "a/.ocd-deploy.json"))
      .toThrow(/placement: .*\(required\)/);
    expect(() => validateDeployManifest({ volume: null, placement: {}, name: "web", build: BUILD }, "a/.ocd-deploy.json"))
      .toThrow(/placement: expected at least one server/);
    for (const count of [0, -1, 1.5, "1"]) {
      expect(() => validateDeployManifest({ volume: null, placement: { "server-2": count }, name: "web", build: BUILD }, "a/.ocd-deploy.json"))
        .toThrow(/placement\.server-2: expected positive integer replica count/);
    }
  });

  test("a volume app is placed on exactly one server with one replica", () => {
    const volume = { size: 5, path: "/data" };
    expect(() => validateDeployManifest({ volume, placement: { "server-2": 1 }, name: "db", build: BUILD }, "a/.ocd-deploy.json"))
      .not.toThrow();
    expect(() => validateDeployManifest({ volume, placement: { "server-2": 2 }, name: "db", build: BUILD }, "a/.ocd-deploy.json"))
      .toThrow(/placement: Apps with a volume must be placed on exactly one server with 1 replica/);
    expect(() => validateDeployManifest({ volume, placement: { "server-2": 1, "sight-capacity-1": 1 }, name: "db", build: BUILD }, "a/.ocd-deploy.json"))
      .toThrow(/exactly one server/);
  });

  test("replicas, durability_class and placement_pool are rejected as unknown keys", () => {
    for (const removed of [{ replicas: 2 }, { durability_class: "high" }, { placement_pool: "general" }]) {
      expect(() => validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", build: BUILD, ...removed }, "a/.ocd-deploy.json"))
        .toThrow(`${Object.keys(removed)[0]}: unknown key`);
    }
  });

  test("CLI-focused domain, environment projection and placement fields validate", () => {
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null, placement: { "server-2": 1 },
        build: BUILD,
        domain: "web.example.com",
        env: {},
      }, "a/.ocd-deploy.json"),
    ).not.toThrow();
  });

  test("basic auth, sticky sessions, IP allowlists, host bind mounts and public raw ports are rejected as unknown keys", () => {
    for (const removed of [
      { auth: { enabled: false } },
      { sticky: true },
      { ip_allowlist: "10.0.0.0/8" },
      { extra_volumes: [{ host_path: "/srv/a", container_path: "/a" }] },
      { public_port: "auto" },
      { public_protocol: "tcp" },
    ]) {
      expect(() => validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", build: BUILD, ...removed }, "a/.ocd-deploy.json"))
        .toThrow(`${Object.keys(removed)[0]}: unknown key`);
    }
  });

  test("environment selectors validate; autoscaling and scale-to-zero are rejected", () => {
    expect(() =>
      validateDeployManifest({
        name: "web",
        volume: null, placement: { "server-2": 1 },
        build: BUILD,
        environment: "production",
      }, "a/.ocd-deploy.json"),
    ).not.toThrow();
    for (const removed of [{ autoscaling: { enabled: true } }, { scale_to_zero_after: 0 }]) {
      expect(() =>
        validateDeployManifest({
          name: "web",
          volume: null, placement: { "server-2": 1 },
          build: BUILD,
          ...removed,
        }, "a/.ocd-deploy.json"),
      ).toThrow();
    }
  });

  test("minimal explicit no-volume manifest validates", () => {
    expect(() => validateDeployManifest({ volume: null, placement: { "server-2": 1 }, name: "web", build: BUILD }, "a/.ocd-deploy.json")).not.toThrow();
  });

  test("legacy top-level `environments` key is rejected", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateDeployManifest(
        { name: "web", volume: null, placement: { "server-2": 1 }, build: BUILD, environments: { staging: { branch: "develop" } } },
        "a/.ocd-deploy.json",
      ),
    ).toThrow(/environments: unknown key/);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("validateStackManifest", () => {
  const validStack = {
    name: "myapp",
    apps: {
      web: { manifest: "web/.ocd-deploy.json" },
      worker: { manifest: "worker/.ocd-deploy.json", needs: ["web"] },
    },
  };

  test("a correct stack passes", () => {
    expect(() => validateStackManifest(validStack, "ocd-stack.json")).not.toThrow();
  });

  test("rejects removed stack configuration fields", () => {
    for (const field of ["env", "env_all"]) {
      expect(() => validateStackManifest({ name: "s", apps: { web: { manifest: "web.json", [field]: [] } } }, "ocd-stack.json")).toThrow(field);
    }
    expect(() => validateStackManifest({ ...validStack, staging_env: [] }, "ocd-stack.json")).toThrow("staging_env");
    expect(() => validateStackManifest({ ...validStack, staging_environment: "staging" }, "ocd-stack.json"))
      .toThrow("staging_environment: unknown key");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() => validateStackManifest({ ...validStack, staging_environment: "staging" }, "ocd-stack.json", { allowUnknown: true }))
      .toThrow("staging_environment: unknown key");
    warn.mockRestore();
  });

  test("needs referencing a missing app key fails", () => {
    let msg = "";
    try {
      validateStackManifest(
        { name: "s", apps: { web: { manifest: "web/.ocd-deploy.json", needs: ["ghost"] } } },
        "ocd-stack.json",
      );
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('apps.web.needs[0]: references "ghost", which is not a declared app key');
  });

  test("empty apps fails", () => {
    expect(() => validateStackManifest({ name: "s", apps: {} }, "ocd-stack.json")).toThrow(/apps:/);
  });

  test("app entry with non-string manifest fails", () => {
    expect(() =>
      validateStackManifest({ name: "s", apps: { web: { manifest: 5 } } }, "ocd-stack.json"),
    ).toThrow(/apps\.web\.manifest: expected a manifest path string, got number \(5\)/);
  });

  test("unknown top-level key fails unless compatibility is explicit", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateStackManifest({ name: "s", apps: { web: { manifest: "w" } }, extra: true }, "ocd-stack.json"),
    ).toThrow(/extra: unknown key/);
    expect(() => validateStackManifest(
      { name: "s", apps: { web: { manifest: "w" } }, extra: true },
      "ocd-stack.json",
      { allowUnknown: true },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Manifest ocd-stack.json: unknown key "extra" (ignored by --allow-unknown)',
    );
    warn.mockRestore();
  });
});

describe("explicit runtime environment", () => {
  test("accepts literals and resource references", () => {
    expect(() => validateDeployManifest({ ...validApp, env: {
      EMPTY: "", MODE: "production", TOKEN: { from: "environment.API_TOKEN" },
      DATABASE_URL: { from: "apps.database.outputs.URL" },
    } }, "app.json")).not.toThrow();
  });
  test("rejects removed declarations and malformed references", () => {
    for (const env of [[{ key: "TOKEN" }], { TOKEN: { from: "API_TOKEN" } }, { TOKEN: 1 }, { "BAD-KEY": "value" }]) {
      expect(() => validateDeployManifest({ ...validApp, env }, "app.json")).toThrow("env");
    }
    for (const field of ["env_projection", "exports"]) {
      expect(() => validateDeployManifest({ ...validApp, [field]: {} }, "app.json")).toThrow(field);
    }
  });
  test("rejects unsupported output template placeholders", () => {
    expect(() => validateDeployManifest({ ...validApp, outputs: { URL: { template: "{environment.TOKEN}" } } }, "app.json")).toThrow("template");
  });
});

describe("stack placement override", () => {
  test("an app entry may replace its child placement with the same shape", () => {
    expect(() => validateStackManifest({
      name: "site",
      apps: { web: { manifest: "web/.ocd-deploy.json", placement: { "server-2": 1, "sight-capacity-1": 1 } } },
    }, "ocd-stack.json")).not.toThrow();
    expect(() => validateStackManifest({
      name: "site",
      apps: { web: { manifest: "web/.ocd-deploy.json", placement: { "server-2": 0 } } },
    }, "ocd-stack.json")).toThrow(/apps\.web\.placement\.server-2/);
    expect(() => validateStackManifest({
      name: "site",
      apps: { web: { manifest: "web/.ocd-deploy.json", replicas: 2 } },
    }, "ocd-stack.json")).toThrow(/replicas: unknown key/);
  });
});

describe("public_ports", () => {
  const turn = {
    name: "turn",
    image: "coturn/coturn:4.7.0",
    volume: null,
    public: false,
    placement: { "turn-1": 1 },
    health_check: { mode: "container" },
    public_ports: [
      { port: 3478, protocol: "udp" },
      { port: 3478, protocol: "tcp" },
      { port: "49160-49999", protocol: "udp" },
    ],
  };

  test("accepts single ports and ranges on one replica per server", () => {
    expect(() => validateDeployManifest(turn, "turn.json")).not.toThrow();
  });

  test("names the field of every problem", () => {
    expect(() => validateDeployManifest({
      ...turn,
      public_ports: [{ port: "3478-3478", protocol: "udp" }, { port: 22, protocol: "tcp" }],
    }, "turn.json")).toThrow(/public_ports\[0\]\.port: expected an integer 1-65535[\s\S]*public_ports\[1\]: 22\/tcp overlaps 22\/tcp/);
    expect(() => validateDeployManifest({ ...turn, public_ports: [{ port: 1, protocol: "sctp" }] }, "turn.json"))
      .toThrow(/public_ports\[0\]\.protocol: expected "tcp" \| "udp"/);
  });

  test("requires one replica per server and a non-HTTP health check", () => {
    expect(() => validateDeployManifest({ ...turn, placement: { "turn-1": 2 } }, "turn.json"))
      .toThrow(/placement: apps with public_ports bind host ports/);
    const { health_check: _omitted, ...withoutHealth } = turn;
    expect(() => validateDeployManifest(withoutHealth, "turn.json"))
      .toThrow(/health_check: apps with public_ports need health_check.mode/);
  });
});
