import { useState, useEffect } from "react";
import { get } from "../../api/client.ts";
import { Btn, StatusBadge, showToast, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { PausedBanner } from "../../components/paused-banner.tsx";
import { ArrowLeft, ExternalLink, Server as ServerIcon } from "lucide-react";
import { OverviewTab, type AppStorageData } from "./overview-tab.tsx";
import { LogsTab } from "./logs-tab.tsx";
import { DeploymentsTab } from "./deployments-tab.tsx";
import { EventsTab } from "./events-tab.tsx";
import type { AppData, ReplicaData, MetricSample, ReplicaEvent, DeploymentRecord } from "../../types.ts";
import { useMobileLayout } from "../../hooks/use-mobile-layout.ts";

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

type AppTab = "overview" | "logs" | "deployments" | "events";

const TABS: Array<{ key: AppTab; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "logs", label: "Logs" },
  { key: "deployments", label: "Deployments" },
  { key: "events", label: "Events" },
];

export function AppDetailPage({ appId }: { appId: number }) {
  const isMobile = useMobileLayout();
  const [app, setApp] = useState<AppData | null>(null);
  const [storage, setStorage] = useState<AppStorageData | null>(null);
  const [tab, setTab] = useState<AppTab>("overview");
  const [logs, setLogs] = useState("");
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [replicas, setReplicas] = useState<ReplicaData[]>([]);
  const [metricsHistory, setMetricsHistory] = useState<MetricSample[]>([]);
  const [replicaEvents, setReplicaEvents] = useState<ReplicaEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [tail, setTail] = useState(100);
  const [selectedReplicaId, setSelectedReplicaId] = useState<number | null>(null);

  const load = async () => {
    try {
      const [nextApp, nextStorage] = await Promise.all([
        get(`/api/apps/${appId}`).catch(() => null),
        get(`/api/apps/${appId}/storage`).catch(() => null),
      ]);
      setApp(nextApp);
      setStorage(nextStorage);
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
      const [reps, hist] = await Promise.all([
        get(`/api/apps/${appId}/replicas`),
        get(`/api/apps/${appId}/metrics/history?since=3600`),
      ]);
      setReplicas(reps);
      setMetricsHistory(hist.samples || []);
    } catch (err) {
      console.error("Failed to load replicas/metrics:", err);
    }
  };

  const loadEvents = async () => {
    setReplicaEvents(await get(`/api/apps/${appId}/events`).catch(() => []) || []);
  };

  useEffect(() => {
    if (tab === "logs") { loadReplicas(); loadLogs(); }
    if (tab === "deployments") loadDeployments();
    if (tab === "overview") loadReplicas();
    if (tab === "events") loadEvents();
  }, [tab, app]);

  useEffect(() => {
    if (tab === "logs" && selectedReplicaId != null) loadLogs();
  }, [selectedReplicaId]);

  if (loading) return <PageState title="Loading app" />;
  if (!app) return <PageState kind="empty" title="App not found" action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/"; }}>Back to apps</Btn>} />;

  const serverNames = (app.placement ?? []).map((entry) => entry.server_name).join(", ");

  return (
    <PageShell className={isMobile ? "!pb-5 !pt-4" : ""}>
      {isMobile ? (
        <header>
          <div className="flex items-start gap-3">
            <button onClick={() => { window.location.hash = "#/"; }} aria-label="Back to apps" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border bg-surface text-fg shadow-xs transition-colors active:bg-subtle"><ArrowLeft size={18} /></button>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">App</p>
              <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">{app.name}</h1>
              <div className="mt-1"><StatusBadge status={app.status} subLabel={app.environment_stale ? "stale environment" : undefined} /></div>
            </div>
          </div>
          {serverNames && (
            <p className="ml-14 mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              <ServerIcon size={12} className="shrink-0" />
              <span className="truncate">{serverNames}</span>
            </p>
          )}
        </header>
      ) : (
        <PageHeader
          backHref="#/"
          backLabel="Apps"
          eyebrow="App"
          title={app.name}
          meta={<>
            <StatusBadge
              status={app.status}
              subLabel={app.environment_stale ? "stale environment" : undefined}
            />
            {serverNames && (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <ServerIcon size={13} className="shrink-0" />
                <span className="text-fg-dim">{serverNames}</span>
              </span>
            )}
            {app.domain && !!app.public && (
              <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="inline-flex min-w-0 items-center gap-1 transition-colors hover:text-fg">
                <span className="truncate font-mono text-xs">{app.domain}</span>
                <ExternalLink size={12} className="shrink-0" />
              </a>
            )}
          </>}
        />
      )}

      {app.status === "paused" && (
        <PausedBanner message="App is paused; containers are frozen and not serving traffic">
          <code className="font-mono text-xs text-muted">ocd unpause {app.name}</code>
        </PausedBanner>
      )}

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <OverviewTab
          app={app}
          appId={appId}
          storage={storage}
          replicas={replicas}
          metricsHistory={metricsHistory}
          setReplicas={setReplicas}
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

      {tab === "deployments" && <DeploymentsTab deployments={deployments} />}

      {tab === "events" && <EventsTab events={replicaEvents} />}
    </PageShell>
  );
}
