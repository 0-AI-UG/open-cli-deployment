import { Badge, Card, CardHeader, EmptyState, StatusBadge, Table, CopyButton, humanize } from "../../components/ui.tsx";
import { Clock } from "lucide-react";
import type { DeploymentRecord } from "../../types.ts";

export function DeploymentsTab({ deployments }: { deployments: DeploymentRecord[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Deployment history"
        icon={<Clock size={15} />}
        description={deployments.length > 0 ? `${deployments.length} deployment${deployments.length === 1 ? "" : "s"}` : undefined}
      />
      {deployments.length === 0 ? (
        <EmptyState message="No deployments yet" icon={Clock} className="!py-10" />
      ) : (
        <Table headers={["ID", "Image", "Digest", "Commit", "Config", "Source", "Status", "Date", ""]}>
          {deployments.map((d) => (
            <tr key={d.id}>
              <td className="font-mono text-xs font-medium text-fg">#{d.id}</td>
              <td className="max-w-[200px] truncate font-mono text-xs text-fg-dim" title={d.image_tag}>{d.image_tag}</td>
              <td className="font-mono text-xs text-fg-dim" title={d.image_digest}>
                {d.image_digest ? d.image_digest.split("@sha256:").pop()?.slice(0, 12) : "—"}
              </td>
              <td className="font-mono text-xs text-fg-dim">{d.git_commit?.slice(0, 7) || "—"}</td>
              <td className="font-mono text-xs text-fg-dim">r{d.config_revision ?? 1}</td>
              <td><Badge>{humanize(d.source || "manual")}</Badge></td>
              <td><StatusBadge status={d.status} /></td>
              <td className="whitespace-nowrap text-xs text-muted">{new Date(d.created_at + "Z").toLocaleString()}</td>
              <td className="text-right">
                {d.status === "failed" && d.deploy_log && (
                  <span className="flex min-w-0 items-center justify-end gap-1">
                    <span className="max-w-[220px] truncate font-mono text-xs text-danger" title={d.deploy_log}>{d.deploy_log}</span>
                    <CopyButton text={d.deploy_log} size={12} />
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
