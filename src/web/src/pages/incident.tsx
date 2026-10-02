import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, History, RefreshCw } from "lucide-react";
import { get, post } from "../api/client.ts";
import { Badge, Btn, Card, CardHeader, InlineNotice, PageHeader, PageShell, SkeletonCard } from "../components/ui.tsx";
import type { Incident } from "../../../shared/incidents.ts";
import { incidentDate, incidentDuration, incidentGuide } from "../lib/incidents.ts";

export function IncidentPage({ id }: { id: string }) {
  const [data, setData] = useState<{ incident: Incident } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(false);
  const mutation = useRef(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    if (mutation.current) return;
    const current = ++request.current;
    setLoading(true);
    try {
      const result = await get(`/api/incidents/${encodeURIComponent(id)}`);
      if (current !== request.current) return;
      setData(result);
      setError("");
    } catch (err) {
      if (current === request.current) setError(err instanceof Error ? err.message : "Could not load incident");
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    setData(null);
    setError("");
    mutation.current = false;
    setResolving(false);
    void load();
    return () => { request.current++; };
  }, [load]);
  const incident = data?.incident.incident_id === id ? data.incident : null;
  useEffect(() => {
    if (!incident || incident.resolved_at !== null) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [incident?.resolved_at, !!incident, load]);
  const resolved = incident?.resolved_at !== null;
  const guide = incident ? incidentGuide(incident.key) : null;
  const markFixed = async () => {
    if (mutation.current) return;
    mutation.current = true;
    setResolving(true);
    setError("");
    const current = ++request.current;
    try {
      const result = await post(`/api/incidents/${encodeURIComponent(id)}/resolve`);
      if (current === request.current) setData(result);
    } catch (err) {
      if (current === request.current) setError(err instanceof Error ? err.message : "Could not mark incident as fixed");
    } finally {
      if (current === request.current) {
        mutation.current = false;
        setResolving(false);
        setLoading(false);
      }
    }
  };
  return <PageShell width="md">
    <PageHeader title="Incident details" eyebrow="Activity" description={incident?.title || "Outage and recovery history"} backHref="#/incidents" backLabel="Back to incidents" actions={<>
      {incident && !resolved && <Btn variant="primary" loading={resolving} disabled={resolving} onClick={() => void markFixed()}><CheckCircle2 size={14} /> Mark as fixed</Btn>}
      <Btn disabled={loading || resolving} onClick={() => void load()}><RefreshCw size={14} /> Refresh</Btn>
    </>} />
    {error && <InlineNotice tone="danger">{error}{incident && " Displaying the last loaded state."}</InlineNotice>}
    {!incident && loading && <SkeletonCard rows={3} label="Loading incident" />}
    {incident && guide && <>
      <Card className={`overflow-hidden ${resolved ? "" : "border-danger/30"}`}>
        <div className={`flex items-start gap-3 p-4 ${resolved ? "" : "bg-danger/5"}`}>
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border ${resolved ? "border-success/20 bg-success/10 text-success" : "border-danger/20 bg-danger/10 text-danger"}`}>
            {resolved ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          </span>
          <div className="min-w-0 flex-1"><h2 className="break-words text-base font-semibold text-fg">{incident.title}</h2><p className="mt-0.5 text-sm text-muted">{guide.category}</p></div>
          <Badge tone={resolved ? "success" : "danger"}>{resolved ? "Resolved" : "Active"}</Badge>
        </div>
        <p className="border-t px-4 py-3 text-sm leading-relaxed text-fg-dim">{resolved ? "This incident has been resolved. This record is retained for review." : guide.condition}</p>
        <dl className="border-t">
          {[ ["Opened", incidentDate(incident.opened_at ?? incident.first_seen)], ["Resolved", incident.resolved_at === null ? "Still active" : incidentDate(incident.resolved_at)], ["Duration", incidentDuration(incident)] ].map(([label, value]) => <div key={label} className="flex min-h-11 items-center justify-between gap-4 border-b px-4 py-2.5 last:border-b-0"><dt className="shrink-0 text-sm text-muted">{label}</dt><dd className="min-w-0 text-right text-sm tabular-nums text-fg">{value}</dd></div>)}
        </dl>
        <a className="flex min-h-[3.25rem] items-center gap-1.5 border-t bg-subtle/40 px-4 py-2 text-sm font-medium text-fg transition-colors hover:bg-subtle max-md:min-h-[3.75rem]" href={`#${incident.path}`}>
          {guide.linkLabel} <ArrowRight size={14} />
        </a>
      </Card>
      <Card className="overflow-hidden">
        <CardHeader title="Timeline" icon={<History size={15} />} />
        <ol className="space-y-0 px-4 py-3 text-sm">
          <TimelineItem tone="neutral" title="Condition first detected"><time dateTime={new Date(incident.first_seen).toISOString()}>{incidentDate(incident.first_seen)}</time></TimelineItem>
          <TimelineItem tone="danger" title={`Incident opened${(incident.opened_at ?? incident.first_seen) > incident.first_seen ? " after the grace period" : ""}`}>{incidentDate(incident.opened_at ?? incident.first_seen)}</TimelineItem>
          <TimelineItem tone={resolved ? "success" : "pending"} title={resolved ? "Incident resolved" : "Awaiting resolution"} last>{resolved ? incidentDate(incident.resolved_at) : "The incident can be marked as fixed manually or resolved automatically by monitoring."}</TimelineItem>
        </ol>
        <p className="break-all border-t px-4 py-2.5 font-mono text-xs text-muted">Incident {incident.incident_id}</p>
      </Card>
    </>}
  </PageShell>;
}

function TimelineItem({ tone, title, last = false, children }: { tone: "neutral" | "danger" | "success" | "pending"; title: string; last?: boolean; children: ReactNode }) {
  const dot = { neutral: "bg-muted/60", danger: "bg-danger", success: "bg-success", pending: "border border-dashed border-line-strong bg-surface" }[tone];
  return <li className="relative flex gap-3">
    <div className="flex w-3 shrink-0 flex-col items-center pt-1.5">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
      {!last && <span className="mt-1 w-px flex-1 bg-line" />}
    </div>
    <div className={`min-w-0 flex-1 ${last ? "" : "pb-4"}`}>
      <div className="font-medium text-fg">{title}</div>
      <div className="mt-0.5 text-xs text-muted">{children}</div>
    </div>
  </li>;
}
