import { StorageMounts } from "../components/storage-mounts.tsx";
import type { StorageMount } from "../../../shared/storage-display.ts";
import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { Card, CardHeader, Btn, CopyButton, DataRow, EmptyState, Stat, Table, StatusBadge, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { Boxes, Server, RefreshCw, Terminal, FileWarning, Network } from "lucide-react";
import { PermissionGate } from "../components/permission-gate.tsx";
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
// proxy's single :18790 listener (PROXY_LISTEN_PORT in src/proxy/config.ts).
// tone "blue" = private-net only.
const PORT_GROUPS = [
  { key: "proxy vip", lo: 18790, hi: 18790, tone: "blue", note: "per-app VIP ingress — L4 proxy listener" },
] as const;

function portGroupKey(port: number): string | null {
  for (const g of PORT_GROUPS) if (port >= g.lo && port <= g.hi) return g.key;
  return null;
}

export function ServerDetailPage({ serverId }: { serverId: number }) {
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [history, setHistory] = useState<ServerMetricSample[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [d, h] = await Promise.all([
        get(`/api/resources/servers/${serverId}`),
        get("/api/resources/metrics/history?since=3600"),
      ]);
      setDetail(d);
      setHistory(h);
    } catch (err: any) {
      setDetailErr(err.message);
    } finally {
      setLoading(false);
    }
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

      <div className="frame bg-surface"><div className="cells grid grid-cols-1 md:grid-cols-3">
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
      </div></div>

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
