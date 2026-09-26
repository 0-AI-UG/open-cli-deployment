import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, RefreshCw } from "lucide-react";
import { get, post } from "../api/client.ts";
import { Badge, Btn, Card, PageHeader, PageShell } from "../components/ui.tsx";
import type { Incident } from "../../../shared/incidents.ts";
import { incidentDate, incidentDuration, incidentGuide } from "../lib/incidents.ts";

export function IncidentPage({ id }: { id: string }) {
  const [data, setData] = useState<{ incident: Incident; canResolve: boolean } | null>(null);
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
  return <PageShell>
    <PageHeader title="Incident details" eyebrow="Operations" description={incident?.title || "Outage and recovery history"} backHref="#/incidents" backLabel="Back to incidents" actions={<>
      {incident && !resolved && data?.canResolve && <Btn variant="primary" loading={resolving} disabled={resolving} onClick={() => void markFixed()}><CheckCircle2 size={13} /> Mark as fixed</Btn>}
      <Btn disabled={loading || resolving} onClick={() => void load()}><RefreshCw size={13} /> Refresh</Btn>
    </>} />
    {error && <div className="border-2 border-accent-red bg-bg-raised p-4 text-sm text-accent-red" role="alert">{error}{incident && " Displaying the last loaded state."}</div>}
    {!incident && loading && <Card className="p-6 font-mono text-xs text-muted">Loading incident…</Card>}
    {incident && guide && <>
      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          {resolved ? <CheckCircle2 className="shrink-0 text-accent-green" size={20} /> : <AlertTriangle className="shrink-0 text-accent-red" size={20} />}
          <div className="min-w-0 flex-1"><h2 className="break-words font-mono text-sm font-bold">{incident.title}</h2><p className="mt-1 text-xs text-muted">{guide.category}</p></div>
          <Badge tone={resolved ? "success" : "danger"}>{resolved ? "Resolved" : "Active"}</Badge>
        </div>
        <p className="text-sm leading-relaxed">{resolved ? "This incident has been resolved. This record is retained for review." : guide.condition}</p>
        <dl className="grid gap-4 border-t border-fg/15 pt-4 sm:grid-cols-3">
          {[ ["Opened", incidentDate(incident.opened_at ?? incident.first_seen)], ["Resolved", incident.resolved_at === null ? "Still active" : incidentDate(incident.resolved_at)], ["Duration", incidentDuration(incident)] ].map(([label, value]) => <div key={label}><dt className="font-mono text-[10px] uppercase text-muted">{label}</dt><dd className="mt-1 font-mono text-xs">{value}</dd></div>)}
        </dl>
        <a className="inline-flex min-h-11 items-center gap-2 font-mono text-xs font-bold underline" href={`#${incident.path}`}>
          {guide.linkLabel} <ArrowRight size={14} />
        </a>
      </Card>
      <Card className="space-y-4 p-5">
        <h2 className="font-mono text-xs font-bold uppercase">Timeline</h2>
        <ol className="space-y-4 border-l-2 border-fg/20 pl-4 text-xs">
          <li><div className="font-bold">Condition first detected</div><time className="text-muted" dateTime={new Date(incident.first_seen).toISOString()}>{incidentDate(incident.first_seen)}</time></li>
          <li><div className="font-bold">Incident opened{(incident.opened_at ?? incident.first_seen) > incident.first_seen ? " after the grace period" : ""}</div><span className="text-muted">{incidentDate(incident.opened_at ?? incident.first_seen)}</span></li>
          <li><div className="font-bold">{resolved ? "Incident resolved" : "Awaiting resolution"}</div><span className="text-muted">{resolved ? incidentDate(incident.resolved_at) : "The incident can be marked as fixed manually or resolved automatically by monitoring."}</span></li>
        </ol>
        <p className="break-all font-mono text-[10px] text-muted">Incident {incident.incident_id}</p>
      </Card>
    </>}
  </PageShell>;
}
