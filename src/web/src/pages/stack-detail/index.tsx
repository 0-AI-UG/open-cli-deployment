import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { Btn, StatusBadge, showToast, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { OverviewTab } from "./overview-tab.tsx";
import { StackLogsTab } from "./logs-tab.tsx";
import type { StackDetail, EnvironmentData } from "../../types.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function StackDetailPage({ stackId }: { stackId: number }) {
  const [stack, setStack] = useState<StackDetail | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [tab, setTab] = useState<"overview" | "logs">("overview");
  const [loading, setLoading] = useState(true);
  const load = async () => {
    try {
      setStack(await get(`/api/stacks/${stackId}`));
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [stackId]);
  useEffect(() => {
    get("/api/environments").then(setEnvironments).catch(() => {});
  }, []);

  if (loading) return <PageState title="Loading stack" />;
  if (!stack) return <PageState kind="empty" title="Stack not found" action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}>Back to apps</Btn>} />;

  const memberApps = stack.apps;

  // Stack configuration and membership come exclusively from ocd-stack.json.
  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "logs", label: "Logs" },
  ] as const;

  return (
    <PageShell>
      <PageHeader
        backHref="#/"
        backLabel="Apps"
        eyebrow="Stack"
        title={stack.name}
        meta={<>
          <StatusBadge status={stack.status} />
          <span>{memberApps.length} app{memberApps.length !== 1 ? "s" : ""}</span>
          {stack.last_operation_id != null && (
            <span className={`inline-flex items-center gap-1.5 text-xs ${stack.last_operation_failed ? "text-danger" : "text-muted"}`}>
              <span>
                Last operation <span className="font-mono">#{stack.last_operation_id}</span>: {stack.last_operation_status}
                {stack.operation_in_progress ? " (in progress)" : ""}
              </span>
            </span>
          )}
          {stack.last_operation_id != null && (stack.last_operation_children || []).length > 0 && (
            <span className="basis-full text-xs text-muted">
              Children: <span className="font-mono">{stack.last_operation_children!.map((child) => `#${child.id} ${child.status}`).join(", ")}</span>
            </span>
          )}
        </>}
      />

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab
          stack={stack}
          memberApps={memberApps}
          environments={environments}
        />
      )}

      {tab === "logs" && <StackLogsTab stackId={stackId} />}
    </PageShell>
  );
}
