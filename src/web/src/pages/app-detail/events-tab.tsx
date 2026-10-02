import { Badge, Card, CardHeader, EmptyState, Table, humanize } from "../../components/ui.tsx";
import { History } from "lucide-react";
import type { ReplicaEvent } from "../../types.ts";

export function EventsTab({ events }: { events: ReplicaEvent[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Replica events" icon={<History size={15} />} description={events.length > 0 ? `Latest ${Math.min(events.length, 50)}` : undefined} />
      {events.length === 0 ? (
        <EmptyState message="No replica events yet" icon={History} className="!py-10" />
      ) : (
        <Table headers={["When", "Event", "From → To", "Reason"]}>
          {events.slice(0, 50).map((event) => (
            <tr key={event.id}>
              <td className="whitespace-nowrap text-xs text-muted">{new Date(`${event.created_at}Z`).toLocaleString()}</td>
              <td><Badge tone={event.to_count > event.from_count ? "info" : "neutral"}>{humanize(event.event_type)}</Badge></td>
              <td className="whitespace-nowrap tabular-nums text-fg">{event.from_count} → {event.to_count}</td>
              <td className="text-fg-dim">{event.reason || "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
