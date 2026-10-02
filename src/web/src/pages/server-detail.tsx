import { StorageMounts } from "../components/storage-mounts.tsx";
import type { StorageMount } from "../../../shared/storage-display.ts";
import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { runCliAction } from "../api/cli-actions.ts";
import { Badge, Card, CardHeader, Btn, CopyButton, DataRow, EmptyState, Stat, Table, StatusBadge, showToast, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { Boxes, Server, RefreshCw, Terminal, FileWarning, Network, Layers, Check, X } from "lucide-react";
import { PermissionGate } from "../components/permission-gate.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { Sparkline, CpuUsage, MemUsage } from "./app-detail/shared.tsx";
import type { ServerMetricSample } from "../types.ts";

type ServerReplica = {
  id: number;
  app_id: number;
  app_name: string;
  container_name: string;
  host_port: number;
  status: string;
  cpu_percent: number;
  memory_percent: number;
  cpu_limit_cores: number;
  memory_used_mb: number;
  memory_limit_mb: number;
  created_at: string;
};

type ReplicaMetricSample = {
  replica_id: number;
  cpu_percent: number;
  memory_percent: number;
  sampled_at: string;
};

type HostProbe = {
  uptime_seconds: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpu_cores: number | null;
  mem_total_mb: number | null;
  mem_used_mb: number | null;
  mem_free_mb: number | null;
  mem_available_mb: number | null;
  mem_buffers_cache_mb: number | null;
  swap_total_mb: number | null;
  swap_used_mb: number | null;
  processes: number | null;
  ports: { proto: string; address: string; port: number; process: string }[];
  net: { iface: string; rx_bytes: number; tx_bytes: number } | null;
  error: string | null;
};

type ServerDetail = {
  local_storage?: StorageMount[];
  id: number;
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  routing_address: string;
  type: string;
  location: string;
  status: string;
  // Capacity pool governing FUTURE replica placement. May be absent from the
  // detail response until the backend includes it — treated as "general".
  pool?: "general" | "staging" | string;
  created_at: string;
  monthly_eur: number | null;
  currency: string;
  cpu_percent: number | null;
  memory_percent: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  replicas: ServerReplica[];
  replica_metrics: ReplicaMetricSample[];
  host: HostProbe;
};

function statusClass(s: string): string {
  if (s === "running") return "text-success";
  if (s === "stopped" || s === "failed") return "text-danger";
  return "text-fg-dim";
}

function Bar({ value, tone }: { value: number; tone: string }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${v}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-muted">{v.toFixed(0)}%</span>
    </div>
  );
}

function fmtUptime(s: number | null): string {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtMb(mb: number | null): string {
  if (mb == null) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// Public-facing well-known ports get a colored dot. Everything else stays neutral.
function portDot(port: number, address: string): string {
  if (port === 80 || port === 443) return "bg-success";
  if (port === 22) return "bg-info";
  if (address === "127.0.0.1" || address === "::1") return "bg-muted/50";
  if (address.startsWith("10.") || address.startsWith("172.") || address.startsWith("192.168.")) return "bg-info";
  return "bg-warning";
}

// Fleet infrastructure ports show up as many near-identical listeners in a raw
// socket scan; collapse each known block into a single summary chip instead of
// flooding the view. Internal ingress is per-app VIPs: every app VIP shares the
// proxy's single :18790 listener (PROXY_LISTEN_PORT in src/proxy/config.ts) and
// wake calls hit the waker's :8896 (WAKER_HTTP_PORT in
// src/engine/scale/traefik-constants.ts). The public pool range mirrors
// src/shared/db/apps.ts (PUBLIC_*).
// tone "blue" = private-net only, "amber" = publicly exposed via the firewall.
const PORT_GROUPS = [
  { key: "proxy vip", lo: 18789, hi: 18790, tone: "blue", note: "per-app VIP ingress — L4 proxy listeners (18790 internal, 18789 public raw)" },
  { key: "waker", lo: 8896, hi: 8896, tone: "blue", note: "scale-to-zero wake endpoint" },
] as const;

function portGroupKey(port: number): string | null {
  for (const g of PORT_GROUPS) if (port >= g.lo && port <= g.hi) return g.key;
  return null;
}

// A pool name is a lowercase slug, ≤32 chars — mirrors the backend validation on
// PATCH /api/servers/:id/pool. Sentinel select value that reveals the "new pool"
// text input instead of switching pools.
const POOL_SLUG = /^[a-z][a-z0-9-]*$/;
const NEW_POOL = "__new-pool__";

export function ServerDetailPage({ serverId }: { serverId: number }) {
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ServerMetricSample[]>([]);
  const [loading, setLoading] = useState(true);
  const [pool, setPool] = useState<string>("general");
  const [poolSaving, setPoolSaving] = useState(false);
  // Known pools from GET /api/pools (always includes general + staging); falls
  // back to those two until the fetch resolves. Plus the inline "new pool" form.
  const [poolOptions, setPoolOptions] = useState<string[]>(["general", "staging"]);
  const [newPoolMode, setNewPoolMode] = useState(false);
  const [newPoolValue, setNewPoolValue] = useState("");
  const [newPoolErr, setNewPoolErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const [d, h] = await Promise.all([
        get(`/api/resources/servers/${serverId}`),
        get("/api/resources/metrics/history?since=3600"),
      ]);
      setDetail(d);
      setPool(d.pool ?? "general");
      setHistory(h);
    } catch (err: any) {
      setDetailErr(err.message);
    } finally {
      setLoading(false);
    }
    // Non-fatal: keep the two hardcoded fallbacks if the pool list can't load.
    try {
      const res = await get("/api/pools");
      if (Array.isArray(res?.pools) && res.pools.length) setPoolOptions(res.pools);
    } catch {
      /* keep fallback */
    }
  };

  const changePool = async (next: string) => {
    const prev = pool;
    if (next === prev) return;
    setPool(next);
    setPoolSaving(true);
    try {
      await runCliAction("servers.pool", { server: String(serverId), pool: next });
      setDetail((d) => (d ? { ...d, pool: next } : d));
      showToast(`Server moved to the "${next}" pool`, "success");
    } catch (err: any) {
      setPool(prev);
      showToast(err?.message || "Failed to change pool", "error");
    } finally {
      setPoolSaving(false);
    }
  };

  // Select handler: sentinel reveals the inline "new pool" input; anything else
  // switches pools directly.
  const onPoolSelect = (v: string) => {
    if (v === NEW_POOL) {
      setNewPoolValue("");
      setNewPoolErr(null);
      setNewPoolMode(true);
      return;
    }
    changePool(v);
  };

  const confirmNewPool = () => {
    const slug = newPoolValue.trim().toLowerCase();
    if (!POOL_SLUG.test(slug) || slug.length > 32) {
      setNewPoolErr("lowercase slug, ≤32 chars");
      return;
    }
    setNewPoolMode(false);
    changePool(slug);
  };

  useEffect(() => { load(); }, [serverId]);

  if (detailErr) {
    return (
      <PageState kind="error" title="Server unavailable" description={detailErr} action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/resources"; }}>Back to resources</Btn>} />
    );
  }
  if (loading || !detail) return <PageState title="Loading server" />;

  const cpuSeries = history.filter((m) => m.server_id === serverId).map((m) => m.cpu_percent);
  const memSeries = history.filter((m) => m.server_id === serverId).map((m) => m.memory_percent);

  const singlePorts = detail.host.ports.filter((p) => portGroupKey(p.port) == null);
  const portBlocks = PORT_GROUPS
    .map((g) => ({ ...g, count: detail.host.ports.filter((p) => p.port >= g.lo && p.port <= g.hi).length }))
    .filter((g) => g.count > 0);

  const metricCell = "bg-surface px-4 py-3.5";
  const poolHint = "New replicas schedule onto servers in this pool. 'staging' isolates staging-target apps from production.";

  return (
    <PageShell>
      <PageHeader
        backHref="#/resources"
        backLabel="Back to resources"
        eyebrow="Server"
        title={detail.name}
        meta={<>
          <StatusBadge status={detail.status} />
          <span className="font-mono text-xs">{detail.type.toUpperCase()}</span>
          <span className="font-mono text-xs">{detail.location}</span>
          {detail.ipv4 && <span className="font-mono text-xs">{detail.ipv4}</span>}
        </>}
        actions={<>
          <PermissionGate
            permission="servers.delete"
            fallback={
              <span title={poolHint} className="inline-flex items-center gap-1.5 text-sm text-muted">
                <Layers size={14} /> Pool <Badge>{pool}</Badge>
              </span>
            }
          >
            {newPoolMode ? (
              <div className="relative flex items-center gap-1">
                <input
                  value={newPoolValue}
                  onChange={(e) => { setNewPoolValue(e.target.value); setNewPoolErr(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmNewPool();
                    if (e.key === "Escape") setNewPoolMode(false);
                  }}
                  placeholder="pool-name"
                  autoFocus
                  aria-invalid={newPoolErr ? true : undefined}
                  className="w-32 font-mono"
                />
                <Btn variant="primary" onClick={confirmNewPool} title="Move to this pool">
                  <Check size={14} />
                </Btn>
                <Btn variant="ghost" onClick={() => setNewPoolMode(false)} title="Cancel">
                  <X size={14} />
                </Btn>
                {newPoolErr && (
                  <span className="absolute left-0 top-full mt-1 whitespace-nowrap text-xs text-danger">
                    {newPoolErr}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2" title={poolHint}>
                <span className="inline-flex items-center gap-1.5 text-sm text-muted"><Layers size={14} /> Pool</span>
                <div className="w-36">
                  <NeoSelect
                    value={pool}
                    disabled={poolSaving}
                    onChange={onPoolSelect}
                    options={[
                      ...Array.from(new Set([...poolOptions, pool])).sort().map((p) => ({ value: p, label: p })),
                      { value: NEW_POOL, label: "+ New pool…" },
                    ]}
                  />
                </div>
              </div>
            )}
          </PermissionGate>
          <PermissionGate permission="terminal.access">
            <Btn onClick={() => { window.location.hash = `#/terminal/server/${detail.id}`; }}>
              <Terminal size={14} /> Shell
            </Btn>
          </PermissionGate>
          <Btn onClick={() => { setLoading(true); load(); }}>
            <RefreshCw size={14} /> Refresh
          </Btn>
        </>}
      />

      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border bg-line shadow-xs md:grid-cols-3">
        <div className={metricCell}>
          <div className="flex items-end justify-between gap-3">
            <Stat
              label="CPU · last hour"
              value={detail.cpu_percent != null && detail.host.cpu_cores
                ? `${((detail.cpu_percent / 100) * detail.host.cpu_cores).toFixed(1)} / ${detail.host.cpu_cores} vCPU`
                : detail.cpu_percent != null ? `${detail.cpu_percent}%` : "—"}
              hint={detail.host.load1 != null
                ? `Load ${detail.host.load1.toFixed(2)} · ${detail.host.load5?.toFixed(2)} · ${detail.host.load15?.toFixed(2)}${detail.host.cpu_cores ? ` / ${detail.host.cpu_cores}` : ""}`
                : undefined}
            />
            <span className="shrink-0 pb-1 text-info"><Sparkline values={cpuSeries} color="currentColor" /></span>
          </div>
        </div>
        <div className={metricCell}>
          <div className="flex items-end justify-between gap-3">
            <Stat
              label="Memory · last hour"
              value={detail.host.mem_total_mb != null
                ? `${fmtMb(detail.host.mem_used_mb)} / ${fmtMb(detail.host.mem_total_mb)}`
                : detail.memory_percent != null ? `${detail.memory_percent}%` : "—"}
              hint={detail.host.mem_total_mb != null
                ? `${detail.memory_percent != null ? `${detail.memory_percent}% used` : ""}${detail.host.swap_total_mb ? ` · swap ${fmtMb(detail.host.swap_used_mb)}` : ""}` || undefined
                : undefined}
            />
            <span className="shrink-0 pb-1 text-warning"><Sparkline values={memSeries} color="currentColor" /></span>
          </div>
        </div>
        <div className={metricCell}>
          {detail.disk_total_gb != null && detail.disk_free_gb != null ? (
            <>
              <Stat
                label="Disk"
                value={`${detail.disk_free_gb} GB free`}
                hint={`of ${detail.disk_total_gb} GB`}
                tone={detail.disk_free_gb < 2 ? "danger" : detail.disk_free_gb < 5 ? "warning" : undefined}
              />
              <div className="mt-2">
                <Bar
                  value={((detail.disk_total_gb - detail.disk_free_gb) / detail.disk_total_gb) * 100}
                  tone={detail.disk_free_gb < 2 ? "bg-danger" : detail.disk_free_gb < 5 ? "bg-warning" : "bg-info"}
                />
              </div>
            </>
          ) : (
            <Stat label="Disk" value="—" hint="No data" />
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Details" icon={<Server size={15} />} />
        <div className="grid md:grid-cols-2 md:divide-x">
          <div>
            <DataRow label="Type" mono>{detail.type.toUpperCase()}</DataRow>
            <DataRow label="Location" mono>{detail.location}</DataRow>
            <DataRow label="Public IPv4" mono>{detail.ipv4 || "—"}{detail.ipv4 && <CopyButton text={detail.ipv4} />}</DataRow>
            <DataRow label="Private IPv4" mono>{detail.routing_address || "—"}{detail.routing_address && <CopyButton text={detail.routing_address} />}</DataRow>
          </div>
          <div className="max-md:border-t">
            <DataRow label="Monthly cost"><span className="tabular-nums">{detail.monthly_eur != null ? `€${detail.monthly_eur.toFixed(2)}` : "—"}</span></DataRow>
            <DataRow label="Uptime"><span className="tabular-nums">{fmtUptime(detail.host.uptime_seconds)}</span></DataRow>
            <DataRow label="Processes"><span className="tabular-nums">{detail.host.processes != null ? String(detail.host.processes) : "—"}</span></DataRow>
            <DataRow label="Created">{new Date(detail.created_at).toLocaleDateString()}</DataRow>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Listening ports"
          icon={<Network size={15} />}
          actions={detail.host.net ? (
            <span className="text-xs tabular-nums text-muted" title={`Network totals on ${detail.host.net.iface}`}>
              ↓ {(detail.host.net.rx_bytes / 1024 / 1024 / 1024).toFixed(1)}G · ↑ {(detail.host.net.tx_bytes / 1024 / 1024 / 1024).toFixed(1)}G
            </span>
          ) : undefined}
        />
        {detail.host.error ? (
          <EmptyState message="Probe failed" icon={FileWarning} />
        ) : !detail.host.ports.length ? (
          <EmptyState message="No listening ports" icon={Network} />
        ) : (
          <div className="flex flex-wrap gap-1.5 p-4">
            {singlePorts.map((p, i) => (
              <span
                key={i}
                title={`${p.address}:${p.port}${p.process ? ` (${p.process})` : ""}`}
                className="inline-flex h-6 items-center gap-1.5 rounded-md border bg-subtle/60 px-2 font-mono text-xs text-fg"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${portDot(p.port, p.address)}`} />
                {p.port}
              </span>
            ))}
            {portBlocks.map((g) => (
              <span
                key={g.key}
                title={`${g.count} listening in ${g.lo}-${g.hi}: ${g.note}, held for the fleet's lifetime`}
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-info/30 bg-info/5 px-2 font-mono text-xs text-fg"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-info" />
                {g.key} {g.lo}-{g.hi} · {g.count}
              </span>
            ))}
          </div>
        )}
      </Card>

      <StorageMounts mounts={detail.local_storage || []} title="Server storage" />

      <Card className="overflow-hidden">
        <CardHeader
          title="Replicas"
          icon={<Boxes size={15} />}
          description={`${detail.replicas.length} replica${detail.replicas.length === 1 ? "" : "s"} scheduled on this server`}
        />
        {!detail.replicas.length ? (
          <EmptyState message="No replicas on this server" icon={Boxes} />
        ) : (
          <div className="max-md:p-3">
          <Table headers={["ID", "Container", "App", "Port", "Status", "CPU", "Memory", "CPU (1h)", ""]}>
            {detail.replicas.map((r) => {
              const series = detail.replica_metrics
                .filter((s) => s.replica_id === r.id)
                .map((s) => s.cpu_percent);
              return (
                <tr key={r.id}>
                  <td className="font-mono text-xs text-muted">#{r.id}</td>
                  <td className="max-w-[16rem] truncate font-mono text-xs text-fg-dim" title={r.container_name}>{r.container_name}</td>
                  <td>
                    <a href={`#/apps/${r.app_id}`} className="font-medium text-fg hover:underline">
                      {r.app_name}
                    </a>
                  </td>
                  <td className="font-mono text-xs text-fg-dim">{r.host_port}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="whitespace-nowrap text-fg-dim"><CpuUsage cpuPercent={r.cpu_percent} limitCores={r.cpu_limit_cores} status={r.status} /></td>
                  <td className="whitespace-nowrap text-fg-dim"><MemUsage memoryPercent={r.memory_percent} usedMb={r.memory_used_mb} limitMb={r.memory_limit_mb} status={r.status} /></td>
                  <td className="text-info"><Sparkline values={series} color="currentColor" /></td>
                  <td className="text-right">
                    <PermissionGate permission="terminal.access">
                      <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/replica/${r.id}`; }}>
                        <Terminal size={13} /> Shell
                      </Btn>
                    </PermissionGate>
                  </td>
                </tr>
              );
            })}
          </Table>
          </div>
        )}
      </Card>

    </PageShell>
  );
}
