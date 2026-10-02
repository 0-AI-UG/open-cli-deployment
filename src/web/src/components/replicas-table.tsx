import { Terminal } from "lucide-react";
import { Btn, StatusBadge, Table } from "./ui.tsx";
import { CpuUsage, MemUsage, Sparkline } from "../pages/app-detail/shared.tsx";

export type ReplicaRow = {
  id: number;
  container_name: string;
  host_port?: number;
  status: string;
  cpu_percent?: number;
  memory_percent?: number;
  cpu_limit_cores?: number;
  memory_used_mb?: number;
  memory_limit_mb?: number;
  /** Shown in the "Server" column (app detail). */
  server?: { id: number; name: string };
  /** Shown in the "App" column (server detail). */
  app?: { id: number; name: string };
};

/** Replica list shared by app detail (one app, many servers) and server detail
 *  (one server, many apps). `cpuSeries` returns the last hour of CPU samples. */
export function ReplicasTable({
  replicas,
  context,
  cpuSeries,
}: {
  replicas: ReplicaRow[];
  context: "app" | "server";
  cpuSeries: (replicaId: number) => number[];
}) {
  const other = context === "app" ? "Server" : "App";
  return (
    <Table headers={["ID", "Container", other, "Port", "Status", "CPU", "Memory", "CPU (1h)", ""]}>
      {replicas.map((r) => (
        <tr key={r.id}>
          <td className="font-mono text-xs font-medium text-fg">#{r.id}</td>
          <td className="max-w-[220px] truncate font-mono text-xs text-fg-dim" title={r.container_name}>{r.container_name}</td>
          <td className="whitespace-nowrap">
            {context === "app"
              ? r.server
                ? <a href={`#/resources/servers/${r.server.id}`} className="text-fg-dim hover:text-fg">{r.server.name}</a>
                : <span className="text-muted">—</span>
              : r.app
                ? <a href={`#/apps/${r.app.id}`} className="font-medium text-fg">{r.app.name}</a>
                : <span className="text-muted">—</span>}
          </td>
          <td className="font-mono text-xs text-fg-dim">{r.host_port ?? "—"}</td>
          <td><StatusBadge status={r.status} /></td>
          <td className="whitespace-nowrap text-fg-dim"><CpuUsage cpuPercent={r.cpu_percent} limitCores={r.cpu_limit_cores} status={r.status} /></td>
          <td className="whitespace-nowrap text-fg-dim"><MemUsage memoryPercent={r.memory_percent} usedMb={r.memory_used_mb} limitMb={r.memory_limit_mb} status={r.status} /></td>
          <td className="text-info"><Sparkline values={cpuSeries(r.id)} color="currentColor" /></td>
          <td className="text-right">
            <Btn size="xs" variant="ghost" onClick={() => { window.location.hash = `#/terminal/replica/${r.id}`; }}>
              <Terminal size={12} /> Shell
            </Btn>
          </td>
        </tr>
      ))}
    </Table>
  );
}
