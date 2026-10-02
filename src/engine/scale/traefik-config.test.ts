import { useTempDataDir, randomSuffix } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import * as db from "../../shared/db.ts";
import {
  collectDesiredState,
  publicTls,
  renderDynamicConfig,
  renderPanelConfig,
} from "./traefik-render.ts";
import {
  traefikInstallScript,
  traefikStaticConfig,
  traefikSystemdUnit,
} from "./traefik-provision.ts";
import {
  TRAEFIK_ACCESS_LOG_PATH,
  TRAEFIK_LOGROTATE_PATH,
} from "./traefik-constants.ts";

// The db module (and its temp data dir) is shared across all test files in
// the bun test process, so every fixture uses unique names and assertions
// select their own slice of the rendered config.

function makeServer(routingAddress = `10.0.0.${Math.floor(Math.random() * 200) + 2}`) {
  return db.insertServer({
    name: `srv-${randomSuffix()}`,
    provider_id: `h-${randomSuffix()}`,
    ipv4: "203.0.113.10",
    ipv6: "",
    type: "cx22",
    location: "fsn1",
    status: "ready",
    routing_address: routingAddress,
  });
}

function makeApp(opts: {
  server: { id: number };
  domain?: string;
  isPublic?: boolean;
  healthCheck?: boolean;
  internalProtocol?: "http" | "tcp";
  replicaStatus?: string | null; // null = no replica at all
  hostPort?: number;
  status?: string;
  rateLimitRps?: number;
  healthCheckPath?: string;
  compress?: boolean;
} ) {
  const name = `app-${randomSuffix()}`;
  const app = db.insertApp({
    name,
    domain: opts.domain ?? `${name}.example.com`,
    image_ref: "ghcr.io/ocd/test@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    container_port: 3000,
    env_vars: "{}",
    public: opts.isPublic ?? true,
    health_check: opts.healthCheck ?? true,
    internal_protocol: opts.internalProtocol,
    rate_limit_rps: opts.rateLimitRps,
    health_check_path: opts.healthCheckPath,
    compress: opts.compress,
  });
  if (opts.replicaStatus !== null) {
    db.insertReplica({
      app_id: app.id,
      server_id: opts.server.id,
      host_port: opts.hostPort ?? 10001,
      container_name: name,
      status: opts.replicaStatus ?? "running",
    });
  }
  if (opts.status) db.updateAppStatus(app.id, opts.status);
  return db.getApp(app.id)!;
}

function stateFor(...appNames: string[]) {
  const state = collectDesiredState();
  return {
    ...state,
    apps: state.apps.filter((a) => appNames.includes(a.name)),
  };
}

function parse(config: string): any {
  return JSON.parse(config);
}

describe("traefikStaticConfig", () => {
  test("entrypoints: web/websecure only; the int20000-20199 internal block is gone (VIP proxy owns internal traffic)", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.entryPoints.web.address).toBe(":80");
    expect(cfg.entryPoints.websecure.address).toBe(":443");
    const intCount = Object.keys(cfg.entryPoints).filter((k) => k.startsWith("int")).length;
    expect(intCount).toBe(0);
    expect(
      Object.values(cfg.entryPoints).some((e: any) => e.address === ":20000"),
    ).toBe(false);
  });

  test("JSON access log with buffering to /var/log/traefik/access.log", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.accessLog).toEqual({
      filePath: TRAEFIK_ACCESS_LOG_PATH,
      format: "json",
      bufferingSize: 100,
    });
  });

  test("file provider watches the dynamic dir; ACME resolver uses httpChallenge on web; no dashboard", () => {
    const cfg = parse(traefikStaticConfig());
    expect(cfg.providers.file).toEqual({ directory: "/etc/traefik/dynamic", watch: true });
    expect(cfg.certificatesResolvers.letsencrypt.acme.httpChallenge.entryPoint).toBe("web");
    expect(cfg.certificatesResolvers.letsencrypt.acme.storage).toBe("/etc/traefik/acme.json");
    expect(cfg.api.dashboard).toBe(false);
  });
});

describe("renderDynamicConfig", () => {
  test("workers render an empty config — internal routing belongs to the VIP proxy now", () => {
    const server = makeServer("10.0.1.2");
    const httpApp = makeApp({ server, hostPort: 10042 });
    const tcpApp = makeApp({ server, internalProtocol: "tcp", healthCheck: false, hostPort: 10050 });
    const gatedApp = makeApp({ server, hostPort: 10044, domain: "g.example.com" });
    const cfg = renderDynamicConfig(stateFor(httpApp.name, tcpApp.name, gatedApp.name), { isPanel: false });
    expect(parse(cfg)).toEqual({});
  });

  test("no rendered router ever targets an int* entrypoint", () => {
    const server = makeServer("10.0.1.22");
    const httpApp = makeApp({ server, hostPort: 10043 });
    const gatedApp = makeApp({ server, hostPort: 10045, domain: "g2.example.com" });
    const cfg = renderDynamicConfig(stateFor(httpApp.name, gatedApp.name), { isPanel: true });
    expect(cfg).not.toContain("int-");
    expect(cfg).not.toContain("int2");
    expect(cfg).not.toContain("internal-http");
  });

  test("tcp-routed public app still proxies HTTP on its domain (same as the old public vhost)", () => {
    const server = makeServer("10.0.1.14");
    const app = makeApp({ server, internalProtocol: "tcp", healthCheck: false, hostPort: 10061, domain: "tcpish.example.com" });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(cfg.tcp).toBeUndefined();
    expect(cfg.http.routers[`pub-${app.name}`].service).toBe(`app-${app.name}`);
    expect(cfg.http.services[`app-${app.name}`].loadBalancer.servers).toEqual([
      { url: "http://10.0.1.14:10061" },
    ]);
  });

  test("public routers render only on the panel, with sec-headers + certResolver", () => {
    const server = makeServer("10.0.1.5");
    const app = makeApp({ server, domain: "shop.example.com", hostPort: 10070 });

    const worker = parse(renderDynamicConfig(stateFor(app.name), { isPanel: false }));
    expect(worker.http?.routers?.[`pub-${app.name}`]).toBeUndefined();

    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    const pub = panel.http.routers[`pub-${app.name}`];
    expect(pub.entryPoints).toEqual(["websecure"]);
    expect(pub.rule).toBe("Host(`shop.example.com`)");
    expect(pub.middlewares).toEqual(["sec-headers", "retry"]);
    expect(pub.service).toBe(`app-${app.name}`);
    expect(pub.tls).toEqual({ certResolver: "letsencrypt" });
    expect(panel.http.middlewares["sec-headers"].headers.customResponseHeaders).toEqual({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-XSS-Protection": "1; mode=block",
    });
    // Global web→websecure redirect exists on the panel.
    const redirect = panel.http.routers["web-to-https"];
    expect(redirect.entryPoints).toEqual(["web"]);
    expect(redirect.middlewares).toEqual(["redirect-https"]);
    expect(panel.http.middlewares["redirect-https"]).toEqual({
      redirectScheme: { scheme: "https", permanent: true },
    });
  });

  test("private app (empty domain) renders nothing even on the panel — the VIP proxy serves it", () => {
    const server = makeServer("10.0.1.6");
    const app = makeApp({ server, isPublic: false, domain: "" });
    const cfg = renderDynamicConfig(stateFor(app.name), { isPanel: true });
    expect(cfg).not.toContain(app.name);
  });

  test("nip.io domain uses tls: {} (default self-signed cert), not the ACME resolver", () => {
    const server = makeServer("10.0.1.7");
    const app = makeApp({ server, domain: `x.203-0-113-10.nip.io` });
    const cfg = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));
    expect(cfg.http.routers[`pub-${app.name}`].tls).toEqual({});
  });

  test("app with zero servable upstreams renders nothing", () => {
    const server = makeServer("10.0.1.9");
    const appNoReplica = makeApp({ server, replicaStatus: null });
    const appDraining = makeApp({ server, replicaStatus: "draining" });
    const cfg = renderDynamicConfig(stateFor(appNoReplica.name, appDraining.name), { isPanel: false });
    expect(cfg).not.toContain(appNoReplica.name);
    expect(cfg).not.toContain(appDraining.name);
  });

  test("active HTTP health check: path renders on the HTTP loadBalancer", () => {
    const server = makeServer("10.0.2.3");
    const httpApp = makeApp({ server, healthCheckPath: "/healthz", hostPort: 10110 });

    const cfg = parse(renderDynamicConfig(stateFor(httpApp.name), { isPanel: true }));
    expect(cfg.http.services[`app-${httpApp.name}`].loadBalancer.healthCheck).toEqual({
      path: "/healthz",
      interval: "10s",
      timeout: "3s",
    });
  });

  test("rate limit: ratelimit middleware (burst = 2x) on the pub- router only", () => {
    const server = makeServer("10.0.2.4");
    const app = makeApp({ server, rateLimitRps: 50, hostPort: 10120 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.middlewares[`ratelimit-${app.name}`]).toEqual({
      rateLimit: { average: 50, burst: 100 },
    });
    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `ratelimit-${app.name}`, "sec-headers", "retry",
    ]);
    // Workers render no pub- router, so the middleware must not orphan there.
    const worker = renderDynamicConfig(stateFor(app.name), { isPanel: false });
    expect(worker).not.toContain(`ratelimit-${app.name}`);
  });

  test("compression: compress middleware on the pub- router only", () => {
    const server = makeServer("10.0.2.6");
    const app = makeApp({ server, compress: true, hostPort: 10140 });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.middlewares[`compress-${app.name}`]).toEqual({ compress: {} });
    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `compress-${app.name}`, "sec-headers", "retry",
    ]);
  });

  test("pub- middleware order: ratelimit → compress → sec-headers → retry", () => {
    const server = makeServer("10.0.2.7");
    const app = makeApp({
      server,
      rateLimitRps: 10,
      healthCheckPath: "/up",
      compress: true,
      hostPort: 10150,
    });
    const panel = parse(renderDynamicConfig(stateFor(app.name), { isPanel: true }));

    expect(panel.http.routers[`pub-${app.name}`].middlewares).toEqual([
      `ratelimit-${app.name}`,
      `compress-${app.name}`,
      "sec-headers",
      "retry",
    ]);
    // Service-level options coexist with the middleware chain.
    const lb = panel.http.services[`app-${app.name}`].loadBalancer;
    expect(lb.healthCheck.path).toBe("/up");
  });

  test("output is deterministic (stable key order) for the content-hash cache", () => {
    const server = makeServer("10.0.1.11");
    const b = makeApp({ server, hostPort: 10081 });
    const a = makeApp({ server, healthCheck: false, hostPort: 10082 });
    const first = renderDynamicConfig(stateFor(a.name, b.name), { isPanel: true });
    const second = renderDynamicConfig(stateFor(a.name, b.name), { isPanel: true });
    expect(first).toBe(second);
    // collectDesiredState sorts apps by name, so a fresh snapshot renders
    // byte-identically too.
    const third = renderDynamicConfig(stateFor(a.name, b.name), { isPanel: true });
    expect(third).toBe(first);
  });
});

describe("renderPanelConfig", () => {
  test("panel vhost: websecure router + web redirect, names disjoint from ocd.yml", () => {
    const cfg = parse(renderPanelConfig("panel.example.com", 3001));
    expect(cfg.http.routers.panel.rule).toBe("Host(`panel.example.com`)");
    expect(cfg.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
    expect(cfg.http.routers["panel-web"].entryPoints).toEqual(["web"]);
    expect(cfg.http.services.panel.loadBalancer.servers).toEqual([
      { url: "http://127.0.0.1:3001" },
    ]);
    // nip.io → default self-signed cert
    const nip = parse(renderPanelConfig("1-2-3-4.nip.io", 3001));
    expect(nip.http.routers.panel.tls).toEqual({});
  });

  test("every real panel domain uses HTTP-01", () => {
    const cfg = parse(renderPanelConfig("panel.zone-test.dev", 3001));
    expect(cfg.http.routers.panel.tls).toEqual({ certResolver: "letsencrypt" });
  });
});

describe("publicTls (HTTP-01 only)", () => {
  test("every real domain uses HTTP-01 and nip.io stays self-signed", () => {
    expect(publicTls("myapp.zone-test.dev")).toEqual({ certResolver: "letsencrypt" });
    expect(publicTls("a.b.zone-test.dev")).toEqual({ certResolver: "letsencrypt" });
    expect(publicTls("x.1-2-3-4.nip.io")).toEqual({});
  });

  test("renderDynamicConfig uses HTTP-01 for default-suffix and custom domains", () => {
    const server = makeServer("10.0.1.12");
    const auto = makeApp({ server, domain: "auto.zone-test.dev", hostPort: 10090 });
    const custom = makeApp({ server, domain: "shop.custom-domain.io", hostPort: 10091 });
    const state = collectDesiredState();
    const cfg = parse(renderDynamicConfig(
      { ...state, apps: state.apps.filter((a) => [auto.name, custom.name].includes(a.name)) },
      { isPanel: true },
    ));
    expect(cfg.http.routers[`pub-${auto.name}`].tls).toEqual({ certResolver: "letsencrypt" });
    expect(cfg.http.routers[`pub-${custom.name}`].tls).toEqual({ certResolver: "letsencrypt" });
  });
});

describe("HTTP-01 static config / unit / install script", () => {
  test("only the HTTP-01 resolver is configured", () => {
    const cfg = parse(traefikStaticConfig());
    expect(Object.keys(cfg.certificatesResolvers)).toEqual(["letsencrypt"]);
    expect(cfg.certificatesResolvers.letsencrypt.acme.httpChallenge).toEqual({ entryPoint: "web" });
    expect(cfg.certificatesResolvers.letsencrypt.acme.storage).toBe("/etc/traefik/acme.json");
  });

  test("systemd and install script contain no DNS provider secret plumbing", () => {
    expect(traefikSystemdUnit()).not.toContain("EnvironmentFile");
    const script = traefikInstallScript();
    expect(script).toContain("chmod 600 /etc/traefik/acme.json");
    expect(script).not.toContain("acme-dns.json");
    expect(script).not.toContain("HETZNER_API_KEY");
  });

  test("install script creates the access-log dir and a logrotate policy so disks never fill", () => {
    const script = traefikInstallScript();
    expect(script).toContain("mkdir -p /var/log/traefik");
    expect(script).toContain(TRAEFIK_LOGROTATE_PATH);
    expect(script).toContain(`${TRAEFIK_ACCESS_LOG_PATH} {`);
    expect(script).toContain("daily");
    expect(script).toContain("rotate 7");
    expect(script).toContain("compress");
    // copytruncate: Traefik keeps the log fd open — rotate without signaling.
    expect(script).toContain("copytruncate");
  });
});
