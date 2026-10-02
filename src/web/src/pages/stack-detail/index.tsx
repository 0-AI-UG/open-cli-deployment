import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { runConfirmedCliAction } from "../../api/cli-actions.ts";
import { Btn, StatusBadge, showToast, confirm, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { trackOperationInToast, useActiveOperations } from "../../hooks/useOperation.ts";
import { Trash2 } from "lucide-react";
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
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  // Stack ops use an id for lifecycle actions and a name for manifest deploys.
  const ops = useActiveOperations(
    (op) =>
      !!op.resource_keys?.some((k) =>
        k === `stack:${stackId}` ||
        (stack != null && k === `stack:${stack.name}`),
      ),
    { rehydrateToasts: true },
  );

  const load = async () => {
    try {
      setStack(await get(`/api/stacks/${stackId}`));
      // The op filter above depends on the stack's name + environment, which we
      // only learn here, so re-prime after loading it.
      ops.refresh();
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

  const action = async (name: string, fn: () => Promise<unknown>) => {
    setActionLoading(name);
    try {
      const result = await fn();
      const opId = result && typeof result === "object" && "op_id" in result
        ? (result as { op_id?: number }).op_id ?? null
        : null;
      if (opId) {
        trackOperationInToast(opId, `${name.charAt(0).toUpperCase() + name.slice(1)} stack`);
        ops.track(opId);
      } else {
        showToast(`${name} successful`, "success");
      }
      load();
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) return <PageState title="Loading stack" />;
  if (!stack) return <PageState kind="empty" title="Stack not found" action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}>Back to overview</Btn>} />;

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
        backLabel="Overview"
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
        actions={<>
          <PermissionGate permission="stacks.destroy" environmentId={stack.environment_id}>
            <Btn
              variant="default"
              loading={actionLoading === "destroy" || ops.isBusyWith("destroy_stack")}
              disabled={ops.isBusy}
              onClick={async () => {
                if (await confirm(
                  "Destroy Stack",
                  `Destroy "${stack.name}" and all ${memberApps.length} app(s)? Containers and routing are removed; environments are retained, and managed volumes are detached for recovery.`,
                  true,
                )) {
                  await action("destroy", () => runConfirmedCliAction(
                    "stacks.delete",
                    { stack: String(stackId) },
                    { action: "delete_stack", resourceType: "stack", resourceId: stackId },
                  ));
                  window.location.hash = "#/";
                }
              }}
            ><Trash2 size={14} /> Destroy</Btn>
          </PermissionGate>
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
