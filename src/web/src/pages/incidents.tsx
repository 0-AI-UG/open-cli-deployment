import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, BellRing, ChevronRight, RefreshCw } from "lucide-react";
import { get } from "../api/client.ts";
import { Badge, Btn, Card, EmptyState, InlineNotice, PageHeader, PageShell, Spinner } from "../components/ui.tsx";
import type { Incident as IncidentItem } from "../../../shared/incidents.ts";
import { useHashParam } from "../hooks/use-hash-param.ts";
import { useActiveIndicator } from "../hooks/use-active-indicator.ts";
import { incidentDate as date, incidentDuration, incidentGuide } from "../lib/incidents.ts";

type Filter = "all" | "active" | "resolved";
type ResponseData = { incidents: IncidentItem[]; nextOffset: number | null; counts: Record<Filter, number> };
const filters: Array<{ key: Filter; label: string }> = [{ key: "all", label: "All" }, { key: "active", label: "Active" }, { key: "resolved", label: "Resolved" }];

export function IncidentsPage() {
  const [filter, setFilter] = useHashParam("status", filters.map((item) => item.key), "active");
  const filterSlider = useActiveIndicator<HTMLDivElement>(filter);
  const [items, setItems] = useState<IncidentItem[]>([]);
  const [counts, setCounts] = useState<Record<Filter, number>>({ all: 0, active: 0, resolved: 0 });
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");

  const request = useRef(0);
  const load = useCallback(async (offset = 0) => {
    const currentRequest = ++request.current;
    if (offset) setMoreBusy(true); else setLoading(true);
    try {
      const result = await get(`/api/incidents?status=${filter}&offset=${offset}`) as ResponseData;
      if (currentRequest !== request.current) return;
      setItems(current => offset ? [...new Map([...current, ...result.incidents].map(item => [item.incident_id, item])).values()] : result.incidents);
      setCounts(result.counts);
      setNextOffset(result.nextOffset);
      setError("");
    } catch (cause) { if (currentRequest === request.current) setError(cause instanceof Error ? cause.message : "Could not load incidents"); }
    finally { if (currentRequest === request.current) { setLoading(false); setMoreBusy(false); } }
  }, [filter]);
  useEffect(() => { setItems([]); setNextOffset(null); void load(); return () => { request.current++; }; }, [load]);

  const cols = "md:grid-cols-[minmax(0,1fr)_9rem_11rem_7rem_1rem]";
  return <PageShell>
    <PageHeader title="Incidents" eyebrow="Operations" description="Monitor active conditions and review recovery history." actions={<Btn disabled={loading || moreBusy} onClick={() => void load()}><RefreshCw size={14} /> Refresh</Btn>} />
    <div className="md:px-6">
      <div ref={filterSlider.containerRef} className="relative inline-flex max-w-full rounded-full border border-line-strong bg-surface p-0.5" role="group" aria-label="Filter incidents">
      <span aria-hidden="true" className="rounded-full bg-primary" style={filterSlider.indicatorStyle} />
      {filters.map(item => {
        const active = filter === item.key;
        return <button key={item.key} type="button" aria-pressed={active} data-active={active} onClick={() => { request.current++; setLoading(true); setFilter(item.key); }} disabled={active} className={`relative inline-flex h-7 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors duration-200 disabled:cursor-default max-md:h-10 ${active ? "text-primary-fg" : "text-muted hover:text-fg"}`}>
          {item.label}
          <span className={`rounded-full px-1.5 text-2xs tabular-nums ${active ? (item.key === "active" && counts.active > 0 ? "bg-danger-solid text-white" : "bg-black/10 text-primary-fg") : "text-muted"}`}>{counts[item.key]}</span>
        </button>;
      })}
    </div>
    </div>
    {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    {loading ? <Card className="flex items-center gap-2 p-6 text-sm text-muted"><Spinner /> Loading incidents…</Card> : items.length ? <Card className="overflow-hidden">
      <div className={`hidden gap-4 border-b bg-subtle/50 px-4 py-2 text-xs font-medium text-muted md:grid ${cols}`}><span>Incident</span><span>Status</span><span>Opened</span><span>Duration</span><span /></div>
      <div className="divide-y">
        {items.map(item => {
          const isResolved = item.resolved_at !== null;
          return <a key={item.incident_id} href={`#/incidents/${encodeURIComponent(item.incident_id)}`} className={`group relative grid min-w-0 gap-2 px-4 py-3 transition-colors hover:bg-subtle/50 md:items-center md:gap-4 ${cols} ${isResolved ? "" : "bg-danger/[0.03]"}`}>
            {!isResolved && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-danger" />}
            <div className="flex min-w-0 items-center gap-3">
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${isResolved ? "bg-subtle text-muted" : "border-danger/20 bg-danger/10 text-danger"}`}><AlertTriangle size={15} /></span>
              <div className="min-w-0">
                <div className="break-words text-sm font-medium text-fg group-hover:underline">{item.title}</div>
                <div className="mt-0.5 break-all text-xs text-muted">{incidentGuide(item.key).category}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-11 md:block md:pl-0">
              <Badge tone={isResolved ? "success" : "danger"}>{isResolved ? "Resolved" : "Active"}</Badge>
              {isResolved && <div className="text-xs text-muted md:mt-1">Resolved {date(item.resolved_at)}</div>}
            </div>
            <div className="pl-11 text-xs tabular-nums text-muted md:pl-0"><span className="md:hidden">Opened </span>{date(item.opened_at ?? item.first_seen)}</div>
            <div className="pl-11 text-xs tabular-nums text-muted md:pl-0"><span className="md:hidden">Duration </span>{incidentDuration(item)}</div>
            <ChevronRight size={14} className="hidden text-muted transition-colors group-hover:text-fg md:block" />
          </a>;
        })}
      </div>
      {nextOffset !== null && <div className="flex justify-center border-t bg-subtle/40 px-4 py-3"><Btn loading={moreBusy} disabled={moreBusy} onClick={() => void load(nextOffset)}>Load more</Btn></div>}
    </Card> : !error && <Card><EmptyState icon={BellRing} message={filter === "all" ? "No incidents yet" : `No ${filter} incidents`} description="Detected outages and recoveries will appear here." /></Card>}
  </PageShell>;
}
