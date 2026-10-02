// Seeds a throwaway panel database with demo servers, stacks and apps so the
// web UI can be previewed locally without real infrastructure.
//
//   bun run dev:demo        → seed .demo-data/ and start the panel on :3002
//   login: demo / 12345678
//
// Runs against OCD_DATA_DIR (defaults to ./.demo-data) and wipes it first, so
// it never touches a real panel's data dir.
import path from "path";
import { rmSync, mkdirSync } from "fs";

const dataDir = path.resolve(process.env.OCD_DATA_DIR || ".demo-data");
if (!process.env.OCD_DATA_DIR) process.env.OCD_DATA_DIR = dataDir;
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

// Import after OCD_DATA_DIR is set — paths.ts reads it at module load.
const db = await import("../src/shared/db.ts");
const conn = db.default;

const digest = (seed: string) =>
  "sha256:" + new Bun.CryptoHasher("sha256").update(seed).digest("hex");

// ── User ──
db.insertUser({
  id: crypto.randomUUID(),
  username: "demo",
  password_hash: await Bun.password.hash("12345678", "bcrypt"),
});
db.saveSetting("default_domain_suffix", "demo.local");

// ── Servers ──
const servers = [
  { name: "fra-web-1", type: "cx32", location: "fsn1", ipv4: "49.12.33.10", status: "running" },
  { name: "fra-web-2", type: "cx32", location: "fsn1", ipv4: "49.12.33.11", status: "running" },
  { name: "nbg-db-1", type: "cx42", location: "nbg1", ipv4: "116.203.8.40", status: "running" },
  { name: "hel-build-1", type: "cpx31", location: "hel1", ipv4: "65.21.4.77", status: "provisioning" },
].map((s, i) =>
  db.insertServer({ ...s, provider_id: `demo-${i + 1}`, ipv6: "", routing_address: s.ipv4 }),
);
const [web1, web2, dbServer] = servers;

// ── Environments ──
const prod = db.insertEnvironment("production", JSON.stringify({ NODE_ENV: "production" }));
const staging = db.insertEnvironment("staging", JSON.stringify({ NODE_ENV: "staging" }));

// ── Stacks + apps ──
type DemoApp = {
  name: string;
  image: string;
  port: number;
  status: string;
  on: typeof servers;
  public?: boolean;
  tcp?: boolean;
};
const stackDefs: Array<{ name: string; env: number; status: string; apps: DemoApp[] }> = [
  {
    name: "storefront",
    env: prod.id,
    status: "running",
    apps: [
      { name: "shop-web", image: "ghcr.io/acme/shop-web", port: 3000, status: "running", on: [web1, web2] },
      { name: "shop-api", image: "ghcr.io/acme/shop-api", port: 8080, status: "running", on: [web1, web2] },
      { name: "shop-worker", image: "ghcr.io/acme/shop-worker", port: 9000, status: "running", on: [web2], public: false },
      { name: "shop-postgres", image: "docker.io/library/postgres", port: 5432, status: "running", on: [dbServer], public: false, tcp: true },
    ],
  },
  {
    name: "analytics",
    env: staging.id,
    status: "deploying",
    apps: [
      { name: "plausible", image: "ghcr.io/plausible/community-edition", port: 8000, status: "deploying", on: [web1] },
      { name: "clickhouse", image: "docker.io/clickhouse/clickhouse-server", port: 8123, status: "running", on: [dbServer], public: false },
    ],
  },
];
const standalone: DemoApp[] = [
  { name: "marketing-site", image: "ghcr.io/acme/marketing", port: 3000, status: "running", on: [web1] },
  { name: "docs", image: "ghcr.io/acme/docs", port: 80, status: "running", on: [web2] },
  { name: "status-page", image: "docker.io/louislam/uptime-kuma", port: 3001, status: "paused", on: [web1] },
  { name: "legacy-cron", image: "ghcr.io/acme/legacy-cron", port: 8080, status: "failed", on: [web2], public: false },
];

let hostPort = 20000;
function createApp(app: DemoApp, stackId: number | null, environmentId: number | null) {
  const row = db.insertApp({
    name: app.name,
    domain: app.public === false ? "" : `${app.name}.demo.local`,
    image_ref: `${app.image}@${digest(app.name)}`,
    container_port: app.port,
    env_vars: "{}",
    environment_id: environmentId,
    public: app.public ?? true,
    internal_protocol: app.tcp ? "tcp" : "http",
    health_check_mode: app.tcp ? "container" : "http",
  });
  conn.query("UPDATE apps SET status = ?, stack_id = ? WHERE id = ?").run(app.status, stackId, row.id);

  for (const server of app.on) {
    const replica = db.insertReplica({
      app_id: row.id,
      server_id: server.id,
      host_port: hostPort++,
      container_name: app.name,
      status: app.status === "failed" ? "unhealthy" : app.status,
    });
    for (let m = 30; m >= 0; m--) {
      conn.query(
        "INSERT INTO metrics_samples (replica_id, app_id, cpu_percent, memory_percent, sampled_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
      ).run(replica.id, row.id, 5 + Math.random() * 40, 20 + Math.random() * 50, `-${m} minutes`);
    }
  }

  for (let d = 3; d >= 1; d--) {
    db.insertDeployment({
      app_id: row.id,
      image_tag: `v1.${10 - d}.0`,
      image_digest: digest(`${app.name}-${d}`),
      git_commit: digest(`${app.name}-commit-${d}`).slice(7, 47),
      status: "deployed",
      source: d === 1 ? "git" : "manual",
      created_at: new Date(Date.now() - d * 86_400_000).toISOString().replace("T", " ").slice(0, 19),
    });
  }
}

for (const def of stackDefs) {
  const stack = db.insertStack({ name: def.name, environment_id: def.env });
  db.updateStackStatus(stack.id, def.status);
  for (const app of def.apps) createApp(app, stack.id, def.env);
}
for (const app of standalone) createApp(app, null, null);

// ── Server metrics (last 30 min) ──
for (const server of servers) {
  for (let m = 30; m >= 0; m--) {
    conn.query(
      "INSERT INTO server_metrics_samples (server_id, cpu_percent, memory_percent, disk_used_gb, disk_total_gb, sampled_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))",
    ).run(server.id, 10 + Math.random() * 50, 30 + Math.random() * 40, 42, 160, `-${m} minutes`);
  }
}

console.log(`[seed-demo] Demo data written to ${dataDir}`);
console.log("[seed-demo] Login: demo / 12345678");
