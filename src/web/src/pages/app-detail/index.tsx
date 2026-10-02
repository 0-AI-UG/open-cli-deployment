import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../../api/cli-actions.ts";
import { Btn, StatusBadge, showToast, confirm, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { PausedBanner } from "../../components/paused-banner.tsx";
import { trackOperationInToast, useResourceOperations } from "../../hooks/useOperation.ts";
import { ArrowLeft, ExternalLink, Play, Pause, RotateCcw, Server as ServerIcon, Trash2 } from "lucide-react";
import { OverviewTab, type AppStorageData } from "./overview-tab.tsx";
import { LogsTab } from "./logs-tab.tsx";
import { DeploymentsTab } from "./deployments-tab.tsx";
import { ScalingTab } from "./scaling-tab.tsx";
import { PromotionTab } from "./promotion-tab.tsx";
import type { AppData, ServerData, ReplicaData, MetricSample, ScalingEvent, DeploymentRecord } from "../../types.ts";
import { useMobileLayout } from "../../hooks/use-mobile-layout.ts";
import { MobileActionSheet, MobileSheetAction } from "../../components/mobile-action-sheet.tsx";
import { MoreHorizontal } from "lucide-react";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function AppDetailPage({ appId }: { appId: number }) {
  const isMobile = useMobileLayout();
  const [app, setApp] = useState<AppData | null>(null);
  const [server, setServer] = useState<ServerData | null>(null);
  const [storage, setStorage] = useState<AppStorageData | null>(null);
  const [tab, setTab] = useState<"overview" | "logs" | "deployments" | "scaling" | "promotion">("overview");
  const [logs, setLogs] = useState("");
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [replicas, setReplicas] = useState<ReplicaData[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricSample[]>([]);
  const [scalingEvents, setScalingEvents] = useState<ScalingEvent[]>([]);
  const [allServers, setAllServers] = useState<ServerData[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const ops = useResourceOperations(`app:${appId}`, { rehydrateToasts: true });
  const [tail, setTail] = useState(100);
  const [selectedReplicaId, setSelectedReplicaId] = useState<number | null>(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);

  const load = async () => {
    try {
      const [servers, nextStorage]: [ServerData[], AppStorageData | null] = await Promise.all([
        get("/api/servers"),
        get(`/api/apps/${appId}/storage`).catch(() => null),
      ]);
      setStorage(nextStorage);
      for (const s of servers) {
        const found = s.apps.find((a) => a.id === appId);
        if (found) { setApp(found); setServer(s); break; }
      }
    } catch (err) {
      showToast(errMessage(err), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [appId]);

  const loadLogs = async () => {
    try {
      const qs = `tail=${tail}${selectedReplicaId != null ? `&replica_id=${selectedReplicaId}` : ""}`;
      const res = await get(`/api/apps/${appId}/logs?${qs}`);
      setLogs(res.logs || res.error || "No logs available");
    } catch (err) {
      setLogs(errMessage(err));
    }
  };

  const loadDeployments = async () => {
    try {
      setDeployments(await get(`/api/apps/${appId}/deployments`));
    } catch (err) {
      console.error("Failed to load deployments:", err);
    }
  };

  const loadReplicas = async () => {
    try {
      const [reps, hist, events, servers] = await Promise.all([
        get(`/api/apps/${appId}/replicas`),
        get(`/api/apps/${appId}/metrics/history?since=3600`),
        get(`/api/apps/${appId}/scaling-events`).catch(() => []),
        get(`/api/servers`).catch(() => []),
      ]);
      setReplicas(reps);
      setMetricsHistory(hist.samples || []);
      setScalingEvents(events || []);
      setAllServers(servers || []);
    } catch (err) {
      console.error("Failed to load replicas/metrics:", err);
    }
  };

  useEffect(() => {
    if (tab === "logs") { loadReplicas(); loadLogs(); }
    if (tab === "deployments") loadDeployments();
    if (tab === "overview" || tab === "scaling") loadReplicas();
  }, [tab, app]);

  useEffect(() => {
    if (tab === "logs" && selectedReplicaId != null) loadLogs();
  }, [selectedReplicaId]);

  const action = async (name: string, fn: () => Promise<unknown>) => {
    setActionLoading(name);
    try {
      const result = await fn();
      const opId = result && typeof result === "object" && "op_id" in result
        ? (result as { op_id?: number }).op_id ?? null
        : null;
      if (opId) {
        trackOperationInToast(opId, `${name.charAt(0).toUpperCase() + name.slice(1)} app`);
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

  if (loading) return <PageState title="Loading app" />;
  if (!app) return <PageState kind="empty" title="App not found" action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}>Back to overview</Btn>} />;

  // Cold-start ETA sub-label for the state badge. Scale-to-zero is a
  // `docker stop` on the tenant host, so wake is always ~1s.
  let badgeSubLabel: string | undefined;
  if (app.status === "sleeping") {
    badgeSubLabel = "wakes in ~1s";
  } else if (app.status === "waking") {
    badgeSubLabel = "starting...";
  }

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "logs", label: "Logs" },
    { key: "deployments", label: "Deployments" },
    { key: "scaling", label: "Scaling" },
    { key: "promotion", label: "Promotion" },
  ] as const;

  return (
    <PageShell className={isMobile ? "!pb-5 !pt-4" : ""}>
      {isMobile ? (
        <header>
          <div className="flex items-start gap-3">
            <button onClick={() => { window.location.hash = "#/"; }} aria-label="Back to overview" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border bg-surface text-fg shadow-xs transition-colors active:bg-subtle"><ArrowLeft size={18} /></button>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">App</p>
              <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">{app.name}</h1>
              <div className="mt-1"><StatusBadge status={app.status} subLabel={app.environment_stale ? "stale environment" : badgeSubLabel} /></div>
            </div>
            <button onClick={() => setMobileActionsOpen(true)} aria-label="App actions" className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors active:bg-subtle"><MoreHorizontal size={20} /></button>
          </div>
          {server && (
            <p className="ml-14 mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <ServerIcon size={12} className="shrink-0" />
              <span className="truncate">{server.name}</span>
              <span className="truncate font-mono">{server.ipv4}</span>
            </p>
          )}
        </header>
      ) : (
        <PageHeader
          backHref="#/"
          backLabel="Overview"
          eyebrow="App"
          title={app.name}
          meta={<>
            <StatusBadge
              status={app.status}
              subLabel={app.environment_stale ? "stale environment" : badgeSubLabel}
            />
            {server && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <ServerIcon size={13} className="shrink-0" />
                <span className="text-fg-dim">{server.name}</span>
                <span className="font-mono text-xs">{server.ipv4}</span>
              </span>
            )}
            {app.domain && !!app.public && (
              <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-fg">
                <span className="truncate font-mono text-xs">{app.domain}</span>
                <ExternalLink size={12} className="shrink-0" />
              </a>
            )}
          </>}
          actions={<>
            <PermissionGate permission="apps.restart" appId={appId} environmentId={app.environment_id}>
              <Btn loading={actionLoading === "restart" || ops.isBusyWith("restart_app")} disabled={ops.isBusy} onClick={() => action("restart", () => runCliAction("app.restart", { app: String(appId) }))}>
                <RotateCcw size={14} /> Restart
              </Btn>
            </PermissionGate>
            <PermissionGate permission="apps.pause" appId={appId} environmentId={app.environment_id}>
              {app.status === "paused" ? (
                <Btn loading={actionLoading === "unpause" || ops.isBusyWith("unpause_app")} disabled={ops.isBusy} onClick={() => action("unpause", () => runCliAction("app.unpause", { app: String(appId) }))}>
                  <Play size={14} /> Unpause
                </Btn>
              ) : (
                <Btn loading={actionLoading === "pause" || ops.isBusyWith("pause_app")} disabled={ops.isBusy} onClick={() => action("pause", () => runCliAction("app.pause", { app: String(appId) }))}>
                  <Pause size={14} /> Pause
                </Btn>
              )}
            </PermissionGate>
            <PermissionGate permission="apps.destroy" appId={appId} environmentId={app.environment_id}>
              <Btn
                variant="ghost"
                className="hover:!bg-danger/10 hover:!text-danger"
                loading={actionLoading === "destroy" || ops.isBusyWith("destroy_app")}
                disabled={ops.isBusy}
                onClick={async () => {
                  if (await confirm("Destroy app", `Permanently destroy "${app.name}"?`, true)) {
                    await action("destroy", () => runConfirmedCliAction(
                      "app.delete",
                      { app: String(appId) },
                      { action: "delete_app", resourceType: "app", resourceId: appId },
                    ));
                    window.location.hash = "#/";
                  }
                }}
              ><Trash2 size={14} /> Destroy</Btn>
            </PermissionGate>
          </>}
        />
      )}

      {app.status === "paused" && (
        <PausedBanner message="App is paused; containers are frozen and not serving traffic">
          <PermissionGate permission="apps.pause" appId={appId} environmentId={app.environment_id}>
            <Btn size="xs" loading={actionLoading === "unpause" || ops.isBusyWith("unpause_app")} disabled={ops.isBusy} onClick={() => action("unpause", () => runCliAction("app.unpause", { app: String(appId) }))}>
              <Play size={13} /> Unpause
            </Btn>
          </PermissionGate>
        </PausedBanner>
      )}

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab
          app={app}
          appId={appId}
          storage={storage}
          replicas={replicas}
          metricsHistory={metricsHistory}
          allServers={allServers}
          setReplicas={setReplicas}
          ops={ops}
        />
      )}

      {tab === "logs" && (
        <LogsTab
          logs={logs}
          tail={tail}
          setTail={setTail}
          loadLogs={loadLogs}
          replicas={replicas}
          selectedReplicaId={selectedReplicaId}
          setSelectedReplicaId={setSelectedReplicaId}
        />
      )}

      {tab === "deployments" && (
        <DeploymentsTab
          appId={appId}
          deployments={deployments}
          action={action}
          ops={ops}
        />
      )}

      {tab === "scaling" && (
        <ScalingTab
          app={app}
          appId={appId}
          replicas={replicas}
          scalingEvents={scalingEvents}
          actionLoading={actionLoading}
          action={action}
          ops={ops}
        />
      )}

      {tab === "promotion" && (
        <PromotionTab
          app={app}
          appId={appId}
          action={action}
          ops={ops}
        />
      )}

      <MobileActionSheet open={isMobile && mobileActionsOpen} onClose={() => setMobileActionsOpen(false)} title={app.name} subtitle={`App · ${app.status}`}>
        <PermissionGate permission="apps.restart" appId={appId} environmentId={app.environment_id}>
          <MobileSheetAction icon={<RotateCcw size={19} />} label="Restart" detail="Restart all running replicas" loading={actionLoading === "restart" || ops.isBusyWith("restart_app")} disabled={ops.isBusy} onClick={() => { setMobileActionsOpen(false); action("restart", () => runCliAction("app.restart", { app: String(appId) })); }} />
        </PermissionGate>
        <PermissionGate permission="apps.pause" appId={appId} environmentId={app.environment_id}>
          <MobileSheetAction icon={app.status === "paused" ? <Play size={19} /> : <Pause size={19} />} label={app.status === "paused" ? "Unpause" : "Pause"} detail={app.status === "paused" ? "Resume serving traffic" : "Stop serving traffic without destroying the app"} disabled={ops.isBusy} onClick={() => { const next = app.status === "paused" ? "unpause" : "pause"; setMobileActionsOpen(false); action(next, () => runCliAction(`app.${next}`, { app: String(appId) })); }} />
        </PermissionGate>
        <PermissionGate permission="apps.destroy" appId={appId} environmentId={app.environment_id}>
          <MobileSheetAction icon={<Trash2 size={19} />} label="Destroy app" detail="Remove containers; DNS stays manual" danger loading={actionLoading === "destroy" || ops.isBusyWith("destroy_app")} disabled={ops.isBusy} onClick={async () => {
            if (await confirm("Destroy app", `Permanently destroy "${app.name}"?`, true)) {
              setMobileActionsOpen(false);
              await action("destroy", () => runConfirmedCliAction(
                "app.delete",
                { app: String(appId) },
                { action: "delete_app", resourceType: "app", resourceId: appId },
              ));
              window.location.hash = "#/";
            }
          }} />
        </PermissionGate>
      </MobileActionSheet>
    </PageShell>
  );
}
