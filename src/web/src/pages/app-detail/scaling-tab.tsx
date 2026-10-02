import { runCliAction } from "../../api/cli-actions.ts";
import { Badge, Card, CardHeader, Btn, Stat, Table, humanize } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Zap, Gauge, History } from "lucide-react";
import type { ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, ScalingEvent } from "../../types.ts";

interface ScalingTabProps {
  app: AppData;
  appId: number;
  replicas: ReplicaData[];
  scalingEvents: ScalingEvent[];
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function ScalingTab({
  app,
  appId,
  replicas,
  scalingEvents,
  actionLoading,
  action,
  ops,
}: ScalingTabProps) {
  const running = replicas.filter((replica) => replica.status !== "stopped").length;
  const desired = app.desired_replicas ?? 1;
  const policy = [
    { label: "Min replicas", value: app.min_replicas ?? 1 },
    { label: "Max replicas", value: app.max_replicas ?? 1 },
    { label: "CPU threshold", value: `${app.autoscale_cpu_threshold ?? 80}%` },
    { label: "Memory threshold", value: `${app.autoscale_mem_threshold ?? 85}%` },
    { label: "Requests/min", value: app.autoscale_req_threshold ?? 0 },
    { label: "Cooldown", value: `${app.autoscale_cooldown ?? 300}s` },
  ];

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Replica state"
          icon={<Zap size={15} />}
          description={app.status === "sleeping" ? "Scaled to zero; the next request wakes it" : undefined}
          actions={app.status === "sleeping" && (
            <PermissionGate permission="apps.restart" appId={appId} environmentId={app.environment_id}>
              <Btn
                variant="primary"
                loading={actionLoading === "wake" || ops.isBusyWith("wake")}
                disabled={ops.isBusy}
                onClick={() => action("wake", () => runCliAction("scale.wake", { app: String(appId) }))}
              >
                Wake app
              </Btn>
            </PermissionGate>
          )}
        />
        <div className="grid grid-cols-2 gap-px bg-line">
          <Stat className="bg-surface px-4 py-3.5" label="Running" value={running} tone={running < desired ? "warning" : undefined} />
          <Stat className="bg-surface px-4 py-3.5" label="Desired" value={desired} />
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Autoscale policy"
          icon={<Gauge size={15} />}
          actions={<Badge tone={app.autoscale_enabled ? "success" : "neutral"}>{app.autoscale_enabled ? "Active" : "Off"}</Badge>}
        />
        <div className={`grid grid-cols-2 gap-px bg-line sm:grid-cols-3 ${app.autoscale_enabled ? "" : "[&>*]:opacity-70"}`}>
          {policy.map((item) => (
            <Stat key={item.label} className="bg-surface px-4 py-3" label={item.label} value={item.value} />
          ))}
        </div>
      </Card>

      {scalingEvents.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Recent scaling events" icon={<History size={15} />} description={`Latest ${Math.min(scalingEvents.length, 20)}`} />
          <Table headers={["When", "Event", "From → To", "Reason"]}>
            {scalingEvents.slice(0, 20).map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap text-xs text-muted">{new Date(`${event.created_at}Z`).toLocaleString()}</td>
                <td><Badge tone={event.to_count > event.from_count ? "info" : "neutral"}>{humanize(event.event_type)}</Badge></td>
                <td className="whitespace-nowrap tabular-nums text-fg">{event.from_count} → {event.to_count}</td>
                <td className="text-fg-dim">{event.reason || "—"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
