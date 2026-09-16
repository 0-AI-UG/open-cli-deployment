import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardList, RefreshCw, Sparkles, Wrench } from "lucide-react";
import { get, post } from "../api/client.ts";
import { Btn, Card, PageHeader, PageShell, showToast } from "../components/ui.tsx";
import type { AgentActivity, AgentField, AgentOption, AgentResult } from "../../../server/lib/incident-agent.ts";
import { useDialogFocus } from "../hooks/use-dialog-focus.ts";

type Run = { id: string; phase: "investigate" | "fix"; status: "running" | "complete" | "failed"; result: AgentResult; activity: AgentActivity[]; error: string };
type Data = { incident: { title: string; key: string; path: string; opened_at: number | null; resolved_at: number | null }; run: Run | null; configured: boolean };

export function IncidentPage({ id }: { id: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<AgentOption | null>(null);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(!!choice, dialogRef);
  useEffect(() => {
    if (!choice) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setChoice(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [choice]);
  const load = useCallback(async () => {
    try { setData(await get(`/api/incidents/${encodeURIComponent(id)}`)); setError(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load incident"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (data?.run?.status !== "running") return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [data?.run?.status, load]);
  const investigate = async () => {
    setBusy(true);
    try { const result = await post(`/api/incidents/${encodeURIComponent(id)}/investigate`, {}); setData(current => current ? { ...current, run: result.run } : current); }
    catch (err) { showToast(err instanceof Error ? err.message : "Investigation failed", "error"); }
    finally { setBusy(false); }
  };
  const fix = async () => {
    if (!choice) return;
    setBusy(true);
    try {
      const result = await post(`/api/incidents/${encodeURIComponent(id)}/fix`, { optionId: choice.id, values });
      setChoice(null);
      setData(current => current ? { ...current, run: result.run } : current);
    } catch (err) { showToast(err instanceof Error ? err.message : "Fix could not start", "error"); }
    finally { setBusy(false); }
  };
  const run = data?.run;
  return <PageShell width="md">
    <PageHeader title="Incident response" eyebrow="Outage" description={data?.incident.title || "Loading incident…"} backHref="#/incidents" backLabel="Back to incidents" actions={<Btn onClick={() => void load()}><RefreshCw size={13} /> Refresh</Btn>} />
    {error && <Card className="p-4 text-sm text-accent-red">{error}</Card>}
    {data && <>
      <Card className="p-4 space-y-3">
        <div className="flex items-start gap-3"><AlertTriangle className="shrink-0 text-accent-red" size={20} /><div className="min-w-0"><div className="font-mono text-xs font-bold">{data.incident.title}</div><div className="mt-1 font-mono text-[10px] text-muted break-all">{data.incident.key}</div></div></div>
        <div className="flex flex-wrap gap-2 font-mono text-[10px]"><span className="border border-fg px-2 py-1">{data.incident.resolved_at ? "Condition cleared" : "Active condition"}</span><a className="border border-fg px-2 py-1 underline" href={`#${data.incident.path}`}>Open affected resource</a></div>
      </Card>
      {!data.configured && <Card className="p-4 text-sm">Set the DeepSeek API key in Incidents → Notifications & agent to enable investigation.</Card>}
      {!run && <Card className="p-5 space-y-4"><div className="flex items-center gap-2 font-mono text-xs font-bold"><Sparkles size={17} /> Investigate with OCD</div><p className="text-xs text-muted">The agent will inspect status, logs and metrics, then present a repair plan for your approval.</p><Btn variant="primary" size="md" disabled={!data.configured || busy} loading={busy} onClick={() => void investigate()}>Investigate issue <ArrowRight size={14} /></Btn></Card>}
      {run?.status === "running" && <Card className="p-5 space-y-2"><div className="flex items-center gap-2 font-mono text-xs font-bold"><RefreshCw size={16} className="animate-spin" /> {run.phase === "fix" ? "Applying fix" : "Investigating"}</div><p className="text-xs text-muted">You can leave this page and return while the agent works.</p><p className="font-mono text-[10px] text-muted">{run.activity.length} OCD command{run.activity.length === 1 ? "" : "s"} completed</p></Card>}
      {run?.status === "failed" && <Card className="p-5 space-y-3"><div className="font-mono text-xs font-bold text-accent-red">Agent stopped</div><p className="text-xs break-words">{run.error}</p><Btn onClick={() => void investigate()} disabled={busy || !data.configured}>Investigate again</Btn></Card>}
      {run?.status === "complete" && <>
        <Card className="p-5 space-y-3"><div className="flex items-center gap-2 font-mono text-xs font-bold">{run.phase === "fix" ? <CheckCircle2 size={17} /> : <ClipboardList size={17} />}{run.result.headline}</div><p className="text-xs leading-relaxed">{run.result.summary}</p></Card>
        {run.result.findings.map((finding, index) => <Card key={index} className={`p-4 space-y-1 border-l-4 ${finding.tone === "warning" ? "border-l-accent-red" : finding.tone === "success" ? "border-l-accent" : "border-l-accent-blue"}`}><div className="font-mono text-[10px] font-bold uppercase">{finding.label}</div><p className="text-xs leading-relaxed whitespace-pre-wrap">{finding.detail}</p></Card>)}
        {run.phase === "investigate" && <section className="space-y-3"><h2 className="font-mono text-[10px] font-bold uppercase tracking-wider">Proposed fixes</h2>{data.incident.resolved_at ? <Card className="p-4 text-xs">This incident has resolved. The proposed fixes are no longer available.</Card> : run.result.options.length ? run.result.options.map(option => <Card key={option.id} className="p-4 space-y-3"><div className="font-mono text-xs font-bold">{option.label}</div><p className="text-xs leading-relaxed">{option.description}</p><Btn variant="primary" onClick={() => { setChoice(option); setValues({}); }}><Wrench size={13} /> Choose fix</Btn></Card>) : <Card className="p-4 text-xs">No safe automated fix was proposed. Review the findings above.</Card>}</section>}
        <Btn onClick={() => void investigate()} disabled={busy}>Investigate again</Btn>
      </>}
      {!!run?.activity.length && <details className="border-2 border-fg bg-bg-raised p-4"><summary className="cursor-pointer font-mono text-[10px] font-bold uppercase">OCD command activity ({run.activity.length})</summary><div className="mt-3 space-y-3">{run.activity.map((step, index) => <div key={index} className="border-t border-fg/20 pt-2"><div className="font-mono text-[10px] font-bold break-all">{step.command} · exit {step.exitCode}</div><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] text-muted">{step.output}</pre></div>)}</div></details>}
    </>}
    {choice && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-fg/50 sm:items-center" onClick={() => setChoice(null)}><div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Fix: ${choice.label}`} className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-t-xl border-2 border-fg bg-bg-raised p-5 shadow-neo sm:rounded-none" onClick={event => event.stopPropagation()}><div className="font-mono text-sm font-bold">{choice.label}</div><p className="mt-2 text-xs leading-relaxed">{choice.description}</p><div className="mt-5 space-y-4">{choice.fields.map(field => <Field key={field.id} field={field} value={values[field.id]} onChange={value => setValues(current => ({ ...current, [field.id]: value }))} />)}</div><div className="mt-6 flex justify-end gap-2 pb-[env(safe-area-inset-bottom)]"><Btn onClick={() => setChoice(null)}>Cancel</Btn><Btn variant="primary" disabled={busy} loading={busy} onClick={() => void fix()}>Apply fix <ArrowRight size={13} /></Btn></div></div></div>}
  </PageShell>;
}

function Field({ field, value, onChange }: { field: AgentField; value: string | number | boolean | undefined; onChange: (value: string | number | boolean) => void }) {
  const common = "mt-1 min-h-11 w-full border-2 border-fg bg-bg px-3 py-2 font-mono text-xs";
  return <label className="block font-mono text-[10px] font-bold uppercase">{field.label}{field.required ? " *" : ""}
    {field.type === "boolean" ? <input type="checkbox" className="ml-3 h-5 w-5 align-middle" checked={value === true} onChange={event => onChange(event.target.checked)} />
      : field.type === "select" ? <select className={common} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)}><option value="">Choose…</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>
      : <input className={common} type={field.type === "number" ? "number" : "text"} placeholder={field.placeholder} value={value === undefined ? "" : String(value)} onChange={event => onChange(field.type === "number" ? Number(event.target.value) : event.target.value)} />}
  </label>;
}
