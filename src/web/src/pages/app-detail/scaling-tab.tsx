import { Badge, Card, CardHeader, Stat, Table, humanize } from "../../components/ui.tsx";
import { Zap, History } from "lucide-react";
import type { AppData, ReplicaData, ScalingEvent } from "../../types.ts";

interface ScalingTabProps {
  app: AppData;
  replicas: ReplicaData[];
  scalingEvents: ScalingEvent[];
}

export function ScalingTab({
  app,
  replicas,
  scalingEvents,
}: ScalingTabProps) {
  const running = replicas.filter((replica) => replica.status === "running").length;
  const placement = app.placement ?? [];
  const desired = placement.reduce((sum, entry) => sum + entry.replicas, 0);

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader title="Placement" icon={<Zap size={15} />} description="Declared in the manifest; OCD runs exactly this many replicas on each server" />
        <div className="grid grid-cols-2 gap-px bg-line">
          <Stat className="bg-surface px-4 py-3.5" label="Running" value={running} tone={running < desired ? "warning" : undefined} />
          <Stat className="bg-surface px-4 py-3.5" label="Declared" value={desired} />
        </div>
        <Table headers={["Server", "Declared", "Running"]}>
          {placement.map((entry) => (
            <tr key={entry.server_id}>
              <td className="text-fg">{entry.server_name}</td>
              <td className="tabular-nums text-fg-dim">{entry.replicas}</td>
              <td className="tabular-nums text-fg-dim">{replicas.filter((replica) => replica.server_id === entry.server_id && replica.status === "running").length}</td>
            </tr>
          ))}
        </Table>
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
