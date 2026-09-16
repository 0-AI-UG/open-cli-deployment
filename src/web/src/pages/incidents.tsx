import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, BellRing, RefreshCw } from "lucide-react";
import { get } from "../api/client.ts";
import { AdminNtfySettings, UserNtfySettings } from "../components/ntfy-settings.tsx";
import { IncidentAgentSettings } from "../components/incident-agent-settings.tsx";
import { TabBar } from "../components/tab-bar.tsx";
import { Badge, Btn, Card, PageHeader, PageShell } from "../components/ui.tsx";
import { useAuth } from "../stores/auth.ts";

type IncidentItem = {
  incident_id: string; key: string; title: string; path: string;
  first_seen: number; opened_at: number | null; resolved_at: number | null;
  agent_phase: "investigate" | "fix" | null; agent_status: "running" | "complete" | "failed" | null;
};
type Filter = "all" | "active" | "resolved";
type ResponseData = { incidents: IncidentItem[]; nextOffset: number | null; counts: Record<Filter, number> };
const sections = [{ key: "incidents", label: "Incidents" }, { key: "settings", label: "Notifications & agent" }] as const;
const filters: Array<{ key: Filter; label: string }> = [{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "resolved", label: "Resolved" }];
const date = (value: number | null) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export function IncidentsPage() {
  const { user } = useAuth();
  const [section, setSection] = useState<(typeof sections)[number]["key"]>("incidents");
  const [filter, setFilter] = useState<Filter>("all");
  const [items, setItems] = useState<IncidentItem[]>([]);
  const [counts, setCounts] = useState<Record<Filter, number>>({ all: 0, active: 0, resolved: 0 });
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (offset = 0) => {
    if (offset) setMoreBusy(true); else setLoading(true);
    try {
      const result = await get(`/api/incidents?status=${filter}&offset=${offset}`) as ResponseData;
      setItems(current => offset ? [...current, ...result.incidents] : result.incidents);
      setCounts(result.counts);
      setNextOffset(result.nextOffset);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load incidents"); }
    finally { setLoading(false); setMoreBusy(false); }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  return <PageShell width="xl">
    <PageHeader title="Incidents" eyebrow="Operations" description="Outages, recovery, notifications, and guided repair." actions={section === "incidents" ? <Btn onClick={() => void load()}><RefreshCw size={13} /> Refresh</Btn> : undefined} />
    <TabBar tabs={sections} active={section} onChange={setSection} />
    {section === "settings" ? <div className="grid gap-5 lg:grid-cols-2"><div className="space-y-5"><UserNtfySettings />{user?.isAdmin && <AdminNtfySettings />}</div>{user?.isAdmin && <div><IncidentAgentSettings /></div>}</div> : <>
      <div className="flex flex-wrap gap-2" aria-label="Filter incidents">{filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} className={`min-h-11 border-2 border-fg px-3 py-2 font-mono text-[10px] font-bold uppercase shadow-neo-sm ${filter === item.key ? "bg-accent" : "bg-bg-raised"}`}>{item.label} <span className="ml-1 opacity-60">{counts[item.key]}</span></button>)}</div>
      {error && <div className="border-2 border-accent-red bg-bg-raised p-4 text-xs text-accent-red" role="alert">{error}</div>}
      {loading ? <Card className="p-6 font-mono text-xs text-muted">Loading incidents…</Card> : items.length ? <div className="space-y-3">
        <div className="hidden grid-cols-[minmax(0,1fr)_9rem_11rem_8rem_1.5rem] gap-4 px-4 font-mono text-[9px] font-bold uppercase tracking-wider text-muted md:grid"><span>Incident</span><span>Status</span><span>Opened</span><span>Agent</span><span /></div>
        {items.map(item => <a key={item.incident_id} href={`#/incidents/${encodeURIComponent(item.incident_id)}`} className="grid min-w-0 gap-3 border-2 border-fg bg-bg-raised p-4 shadow-neo-sm transition-colors hover:bg-alt md:grid-cols-[minmax(0,1fr)_9rem_11rem_8rem_1.5rem] md:items-center md:gap-4">
          <div className="flex min-w-0 items-start gap-3"><AlertTriangle size={16} className={item.resolved_at ? "mt-0.5 shrink-0 text-muted" : "mt-0.5 shrink-0 text-accent-red"} /><div className="min-w-0"><div className="break-words font-mono text-xs font-bold">{item.title}</div><div className="mt-1 break-all font-mono text-[10px] text-muted">{item.key}</div></div></div>
          <div><Badge tone={item.resolved_at ? "success" : "danger"}>{item.resolved_at ? "Resolved" : "Active"}</Badge>{item.resolved_at && <div className="mt-1 font-mono text-[9px] text-muted md:hidden">Resolved {date(item.resolved_at)}</div>}</div>
          <div className="font-mono text-[10px] text-muted"><span className="md:hidden">Opened </span>{date(item.opened_at || item.first_seen)}</div>
          <div className="font-mono text-[10px] text-muted">{item.agent_status ? `${item.agent_phase === "fix" ? "Fix" : "Investigation"} ${item.agent_status}` : "Not investigated"}</div>
          <ArrowRight size={17} className="hidden text-fg md:block" />
        </a>)}
        {nextOffset !== null && <div className="flex justify-center py-2"><Btn loading={moreBusy} disabled={moreBusy} onClick={() => void load(nextOffset)}>Load more</Btn></div>}
      </div> : <Card className="p-8 text-center"><BellRing size={22} className="mx-auto text-muted" /><h2 className="mt-3 font-mono text-xs font-bold">{filter === "all" ? "No incidents yet" : `No ${filter} incidents`}</h2><p className="mt-2 text-xs text-muted">Detected outages and recoveries will appear here.</p></Card>}
    </>}
  </PageShell>;
}
