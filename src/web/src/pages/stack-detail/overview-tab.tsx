import { Badge, Card, CardHeader, DataRow, StatusBadge, Table, EmptyState } from "../../components/ui.tsx";
import { Boxes, ChevronRight, ExternalLink, Layers, Settings2 } from "lucide-react";
import type { StackDetail, StackMemberApp, EnvironmentData } from "../../types.ts";

/**
 * The whole stack on one page: what it is configured with and what it contains.
 * Stack configuration is declarative and comes from `ocd-stack.json`.
 */
export function OverviewTab({
  stack,
  memberApps,
  environments,
}: {
  stack: StackDetail;
  memberApps: StackMemberApp[];
  environments: EnvironmentData[];
}) {
  const envName = (id: number | null) =>
    id == null ? null : environments.find((e) => e.id === id)?.name ?? `#${id}`;
  const prodEnv = envName(stack.environment_id);
  // `needs` edges from the stack manifest, persisted per member. They are what
  // orders deploys into levels, so they belong on this page even
  // though they're only editable in `ocd-stack.json`.
  const needsOf = (a: StackMemberApp): string[] => {
    try {
      const parsed = a.stack_needs ? JSON.parse(a.stack_needs) : [];
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Configuration" icon={<Settings2 size={15} />} description="Declared in ocd-stack.json" />
          <DataRow label="Created">{new Date(stack.created_at).toLocaleString()}</DataRow>
          <DataRow label="Environment" className={prodEnv ? "relative transition-colors hover:bg-subtle/50" : ""}>
            {prodEnv
              ? <a href="#/environments" className="stretched-link font-medium text-fg">{prodEnv}</a>
              : <span className="text-muted">None</span>}
          </DataRow>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader title="Rollout" icon={<Layers size={15} />} description="Member state" />
          <DataRow label="Apps"><span className="tabular-nums">{memberApps.length}</span></DataRow>
          <DataRow label="Status"><StatusBadge status={stack.status} /></DataRow>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader
          title="Apps"
          icon={<Boxes size={15} />}
          description={`${memberApps.length} member${memberApps.length === 1 ? "" : "s"}`}
        />
        {memberApps.length === 0 ? (
          <EmptyState message="This stack has no apps" icon={Boxes} description="Members are declared in ocd-stack.json." />
        ) : (
          <Table headers={["Name", "Status", "Domain", "Needs", ""]}>
            {memberApps.map((a) => (
              <tr key={a.id} className="cursor-pointer" onClick={() => { window.location.hash = `#/apps/${a.id}`; }}>
                <td>
                  <a href={`#/apps/${a.id}`} className="font-medium text-fg">{a.name}</a>
                </td>
                <td>
                  <StatusBadge
                    status={a.status}
                    subLabel={a.environment_stale ? "stale environment — redeploy required" : undefined}
                  />
                </td>
                <td>
                  {a.domain && a.public
                    ? <a href={`https://${a.domain}`} target="_blank" rel="noopener" onClick={(event) => event.stopPropagation()} className="inline-flex items-center gap-1 font-mono text-xs text-fg-dim transition-colors hover:text-fg">{a.domain} <ExternalLink size={11} className="shrink-0 text-muted" /></a>
                    : <Badge>Private</Badge>}
                </td>
                <td className="font-mono text-xs text-fg-dim">
                  {needsOf(a).length ? needsOf(a).join(", ") : <span className="text-muted">—</span>}
                </td>
                <td className="text-right">
                  <a href={`#/apps/${a.id}`} className="inline-flex items-center gap-0.5 text-xs font-medium text-muted transition-colors hover:text-fg">Open <ChevronRight size={13} /></a>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
