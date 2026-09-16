import { useEffect, useState } from "react";
import { get, put, post } from "../api/client.ts";
import { Card, Btn, Field, StatusBadge, showToast } from "./ui.tsx";
import { NeoSelect } from "./neo-select.tsx";
import { Bell, BellRing, Check, Copy, ExternalLink, RefreshCw, Send, Server } from "lucide-react";
import type { NtfyPreferences, NtfySettings } from "../../../shared/ntfy-schema.ts";

const defaultSettings: NtfySettings = { enabled: true, app_id: null, alerts: true, apps: true, ios_push: false, cache_hours: 24 };
type ServiceState = { settings: NtfySettings | null; app: { id: number; name: string; domain: string; status: string } | null; apps: { id: number; name: string }[]; servers: { id: number; name: string }[]; opId: number | null; delivery: { pending: number; failed: number } };

function ToggleRow({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`flex min-h-11 items-center justify-between gap-4 border-b border-fg/10 py-2 last:border-b-0 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
    <span className="min-w-0"><span className="block font-mono text-[10px] font-bold text-fg">{label}</span>{detail && <span className="mt-0.5 block font-mono text-[9px] text-muted">{detail}</span>}</span>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} aria-label={label} />
  </label>;
}

function ConnectionRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return <div className="flex items-center gap-3 border-b border-fg/10 py-2 last:border-b-0">
    <span className="w-16 shrink-0 font-mono text-[9px] font-bold uppercase text-muted">{label}</span>
    <code className="min-w-0 flex-1 break-all font-mono text-[10px] text-fg">{value}</code>
    <Btn size="xs" onClick={copy} ariaLabel={`Copy ${label.toLowerCase()}`}>{copied ? <Check size={11} /> : <Copy size={11} />} {copied ? "Copied" : "Copy"}</Btn>
  </div>;
}
export function AdminNtfySettings() {
  const [form, setForm] = useState(defaultSettings);
  const [state, setState] = useState<ServiceState | null>(null);
  const [create, setCreate] = useState({ name: "ntfy", domain: "", server_id: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(initial = false) {
    const s = await get("/api/admin/ntfy") as ServiceState;
    setState(s);
    if (initial && s.settings) setForm(s.settings);
    else setForm(f => ({ ...f, app_id: s.app?.id ?? f.app_id }));
    setCreate(c => ({ ...c, server_id: c.server_id || s.servers[0]?.id || 0 }));
  }
  useEffect(() => { load(true).catch(e => setError(e.message)); const timer = window.setInterval(() => { load().catch(() => {}); }, 10000); return () => window.clearInterval(timer); }, []);
  async function apply(creating = false) {
    setBusy(true); setError("");
    try {
      const result = creating ? await post("/api/admin/ntfy/app", create) : await put("/api/admin/ntfy", form);
      setState(s => s ? { ...s, opId: result.opId } : s);
      showToast(creating ? "ntfy app deployment queued" : "Notification settings queued", "success");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <Card className="overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-fg p-5">
      <div className="flex items-center gap-3"><span className="border-2 border-fg bg-accent p-2 shadow-neo-sm"><BellRing size={17} /></span><div><h2 className="font-mono text-[10px] font-bold uppercase tracking-wider">Shared notifications</h2><p className="mt-1 font-mono text-[9px] text-muted">OCD alerts and private app topics</p></div></div>
      {state?.app && <StatusBadge status={state.app.status} />}
    </div>
    <div className="space-y-4 p-5">
      {error && <p role="alert" className="border-2 border-accent-red bg-accent-red/10 p-3 text-xs text-accent-red">{error}</p>}
      {!state ? <p className="font-mono text-[10px] text-muted">Loading notifications…</p> : state.app ? <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-fg bg-alt p-3"><div className="min-w-0"><div className="font-mono text-[10px] font-bold">{state.app.name}</div><div className="truncate font-mono text-[9px] text-muted">{state.app.domain}</div></div><a href={`#/apps/${state.app.id}`} className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline">Open app <ExternalLink size={11} /></a></div> : <div className="space-y-3 border-2 border-fg bg-alt/30 p-4">
        <h3 className="font-mono text-[10px] font-bold uppercase">Create notification app</h3>
        <Field label="App name"><input value={create.name} onChange={e => setCreate({ ...create, name: e.target.value })} /></Field>
        <Field label="HTTPS domain"><input value={create.domain} placeholder="notify.example.com" onChange={e => setCreate({ ...create, domain: e.target.value })} /></Field>
        <Field label="Server"><NeoSelect value={String(create.server_id || "")} options={state.servers.map(s => ({ value: String(s.id), label: s.name }))} onChange={v => setCreate({ ...create, server_id: Number(v) })} placeholder="Select a server" /></Field>
        <div className="flex justify-end"><Btn variant="primary" loading={busy} disabled={!create.name.trim() || !create.domain || !create.server_id} onClick={() => apply(true)}>Create app</Btn></div>
        {!!state.apps.length && <Field label="Existing ntfy app"><NeoSelect value={String(form.app_id || "")} options={state.apps.map(a => ({ value: String(a.id), label: a.name }))} onChange={v => setForm({ ...form, app_id: Number(v) })} placeholder="Select an app" /></Field>}
      </div>}
      {!!form.app_id && <div className="border-2 border-fg p-4">
        <h3 className="mb-2 font-mono text-[10px] font-bold uppercase">Integration</h3>
        <ToggleRow label="Enabled" checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })} />
        <ToggleRow label="OCD alerts" checked={form.alerts} onChange={alerts => setForm({ ...form, alerts })} />
        <ToggleRow label="App topics" checked={form.apps} onChange={apps => setForm({ ...form, apps })} />
        <ToggleRow label="iOS push" detail="Uses the ntfy.sh wake-up relay" checked={form.ios_push} onChange={ios_push => setForm({ ...form, ios_push })} />
        <Field label="Retain messages (hours)"><input type="number" min={1} max={168} value={form.cache_hours} onChange={e => setForm({ ...form, cache_hours: Number(e.target.value) })} /></Field>
        <div className="mt-4 flex justify-end"><Btn variant="primary" loading={busy} onClick={() => apply()}>Save settings</Btn></div>
      </div>}
      {(state?.opId || state?.delivery?.pending || state?.delivery?.failed) && <div className="flex flex-wrap items-center gap-3 border-t border-fg/15 pt-3 font-mono text-[9px] text-muted">{state?.opId && <a className="font-bold text-accent-blue hover:underline" href={`#/engine/op/${state.opId}`}>View operation →</a>}{!!state?.delivery?.pending && <span>{state.delivery.pending} queued</span>}{!!state?.delivery?.failed && <span className="text-accent-red">{state.delivery.failed} failed</span>}</div>}
    </div>
  </Card>;
}

export function UserNtfySettings() {
  const [state, setState] = useState<any>(null);
  const [form, setForm] = useState<NtfyPreferences>({ enabled: false, events: ["app", "delivery", "disk", "backup"], recovery: true });
  const [secret, setSecret] = useState<{ password: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() { const s = await get("/api/auth/notifications"); setState(s); setForm(s.preferences); }
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  async function action(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  return <Card className="overflow-hidden">
    <div className="flex items-center gap-3 border-b-2 border-fg p-5"><Bell size={14} /><h2 className="font-mono text-[10px] font-bold uppercase tracking-wider">Notifications</h2>{state && <span className={`ml-auto border-2 border-fg px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${form.enabled && state.available ? "bg-accent" : "bg-alt"}`}>{form.enabled && state.available ? "On" : "Off"}</span>}</div>
    <div className="space-y-4 p-5">
      {error && <p role="alert" className="border-2 border-accent-red bg-accent-red/10 p-3 text-xs text-accent-red">{error}</p>}
      {!state ? <p className="font-mono text-[10px] text-muted">Loading notifications…</p> : <>
        {!state.available && <p className="border-2 border-fg bg-alt p-3 font-mono text-[10px]">Shared notifications are unavailable. Ask an administrator to enable them.</p>}
        <div className="border-2 border-fg px-4">
          <ToggleRow label="Send me OCD alerts" checked={form.enabled} disabled={!state.available && !form.enabled} onChange={enabled => setForm({ ...form, enabled })} />
          {([['app', 'Unhealthy apps'], ['delivery', 'Failed deployments'], ['disk', 'Disk pressure'], ['backup', 'Panel backups']] as const).map(([key, label]) => <ToggleRow key={key} label={label} checked={form.events.includes(key)} disabled={!form.enabled} onChange={checked => setForm({ ...form, events: checked ? [...form.events, key] : form.events.filter(k => k !== key) })} />)}
          <ToggleRow label="Recovery notices" checked={form.recovery} disabled={!form.enabled} onChange={recovery => setForm({ ...form, recovery })} />
        </div>
        <div className="flex justify-end"><Btn variant="primary" loading={busy} onClick={() => action(async () => { await put("/api/auth/notifications", form); setSecret(null); await load(); showToast("Notification preferences saved", "success"); })}>Save preferences</Btn></div>
        {state.connection && <div className="border-2 border-fg">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-fg bg-alt px-4 py-3"><div className="flex items-center gap-2"><Server size={13} /><h3 className="font-mono text-[10px] font-bold uppercase">Connect your ntfy client</h3></div><a href={state.connection.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase text-accent-blue hover:underline">Open server <ExternalLink size={10} /></a></div>
          <div className="px-4"><ConnectionRow label="Server" value={state.connection.url} /><ConnectionRow label="Topic" value={state.connection.topic} /><ConnectionRow label="User" value={state.connection.username} />{secret && <ConnectionRow label="Password" value={secret.password} />}</div>
          <div className="flex flex-wrap items-center gap-2 border-t border-fg/15 px-4 py-3"><Btn size="xs" disabled={busy} onClick={() => action(async () => { if (secret) setSecret(null); else setSecret(await post("/api/auth/notifications/credentials", {})); })}>{secret ? "Hide password" : "Show password"}</Btn><Btn size="xs" disabled={busy || !state.available} onClick={() => action(async () => { await post("/api/auth/notifications/test", {}); showToast("Test notification queued", "success"); })}><Send size={11} /> Send test</Btn><Btn size="xs" disabled={busy} onClick={() => action(load)}><RefreshCw size={11} /> Refresh</Btn>{state.delivery && <span className="font-mono text-[9px] text-muted">{state.delivery.sent_at ? "Delivered" : state.delivery.error || "Queued"}</span>}</div>
        </div>}
      </>}
    </div>
  </Card>;
}
