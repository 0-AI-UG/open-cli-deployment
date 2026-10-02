import { useEffect, useState } from "react";
import { get, put, post } from "../api/client.ts";
import { Card, CardHeader, Badge, Btn, Field, InlineNotice, Spinner, StatusBadge, showToast } from "./ui.tsx";
import { NeoSelect } from "./neo-select.tsx";
import { Bell, BellRing, Check, Copy, ExternalLink, RefreshCw, Send, Server } from "lucide-react";
import type { NtfyPreferences, NtfySettings } from "../../../shared/ntfy-schema.ts";

const defaultSettings: NtfySettings = { enabled: true, app_id: null, alerts: true, apps: true, ios_push: false, cache_hours: 24 };
type ServiceState = { settings: NtfySettings | null; app: { id: number; name: string; domain: string; status: string } | null; apps: { id: number; name: string }[]; servers: { id: number; name: string }[]; opId: number | null; delivery: { pending: number; failed: number } };

function ToggleRow({ label, detail, checked, disabled, onChange }: { label: string; detail?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className={`flex min-h-11 items-center justify-between gap-4 border-b py-2.5 last:border-b-0 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
    <span className="min-w-0"><span className="block text-sm font-medium text-fg">{label}</span>{detail && <span className="mt-0.5 block text-xs text-muted">{detail}</span>}</span>
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
  return <div className="flex min-h-11 items-center gap-3 border-b py-2 last:border-b-0">
    <span className="w-20 shrink-0 text-sm text-muted">{label}</span>
    <code className="min-w-0 flex-1 break-all font-mono text-xs text-fg">{value}</code>
    <Btn size="xs" variant="ghost" onClick={copy} ariaLabel={`Copy ${label.toLowerCase()}`}>{copied ? <Check size={12} className="text-success" /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</Btn>
  </div>;
}
export function NtfyServiceSettings() {
  const [form, setForm] = useState(defaultSettings);
  const [state, setState] = useState<ServiceState | null>(null);
  const [create, setCreate] = useState({ name: "ntfy", domain: "", server_id: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(initial = false) {
    const s = await get("/api/ntfy") as ServiceState;
    setState(s);
    if (initial && s.settings) setForm(s.settings);
    else setForm(f => ({ ...f, app_id: s.app?.id ?? f.app_id }));
    setCreate(c => ({ ...c, server_id: c.server_id || s.servers[0]?.id || 0 }));
  }
  useEffect(() => { load(true).catch(e => setError(e.message)); const timer = window.setInterval(() => { load().catch(() => {}); }, 10000); return () => window.clearInterval(timer); }, []);
  async function apply(creating = false) {
    setBusy(true); setError("");
    try {
      const result = creating ? await post("/api/ntfy/app", create) : await put("/api/ntfy", form);
      setState(s => s ? { ...s, opId: result.opId } : s);
      showToast(creating ? "ntfy app deployment queued" : "Notification settings queued", "success");
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <Card className="overflow-hidden">
    <CardHeader icon={<BellRing size={15} />} title="Shared notifications" description="OCD alerts and private app topics" actions={state?.app ? <StatusBadge status={state.app.status} /> : undefined} />
    {error && <div className="px-4 pt-4"><InlineNotice tone="danger">{error}</InlineNotice></div>}
    {!state ? <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted"><Spinner /> Loading notifications…</div> : state.app ? <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted"><Bell size={15} /></span>
        <div className="min-w-0"><div className="truncate text-sm font-medium text-fg">{state.app.name}</div><div className="truncate font-mono text-xs text-muted">{state.app.domain}</div></div>
      </div>
      <a href={`#/apps/${state.app.id}`} className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-fg hover:underline">Open app <ExternalLink size={13} /></a>
    </div> : <div className="border-b">
      <div className="px-4 pt-4"><h3 className="text-sm font-semibold text-fg">Create notification app</h3><p className="mt-0.5 text-xs text-muted">Deploy a private ntfy server for OCD alerts.</p></div>
      <div className="px-4">
        <Field divider label="App name"><input value={create.name} onChange={e => setCreate({ ...create, name: e.target.value })} /></Field>
        <Field divider label="HTTPS domain"><input className="font-mono" value={create.domain} placeholder="notify.example.com" onChange={e => setCreate({ ...create, domain: e.target.value })} /></Field>
        <Field divider label="Server"><NeoSelect value={String(create.server_id || "")} options={state.servers.map(s => ({ value: String(s.id), label: s.name }))} onChange={v => setCreate({ ...create, server_id: Number(v) })} placeholder="Select a server" /></Field>
      </div>
      <div className="flex justify-end gap-2 border-t bg-subtle/40 px-4 py-3"><Btn variant="primary" loading={busy} disabled={!create.name.trim() || !create.domain || !create.server_id} onClick={() => apply(true)}>Create app</Btn></div>
      {!!state.apps.length && <div className="border-t px-4"><Field label="Existing ntfy app"><NeoSelect value={String(form.app_id || "")} options={state.apps.map(a => ({ value: String(a.id), label: a.name }))} onChange={v => setForm({ ...form, app_id: Number(v) })} placeholder="Select an app" /></Field></div>}
    </div>}
    {!!form.app_id && <>
      <div className="px-4 pt-4"><h3 className="text-sm font-semibold text-fg">Integration</h3></div>
      <div className="px-4">
        <ToggleRow label="Enabled" checked={form.enabled} onChange={enabled => setForm({ ...form, enabled })} />
        <ToggleRow label="OCD alerts" checked={form.alerts} onChange={alerts => setForm({ ...form, alerts })} />
        <ToggleRow label="App topics" checked={form.apps} onChange={apps => setForm({ ...form, apps })} />
        <ToggleRow label="iOS push" detail="Uses the ntfy.sh wake-up relay" checked={form.ios_push} onChange={ios_push => setForm({ ...form, ios_push })} />
        <Field label="Retain messages (hours)" className="border-t"><input type="number" min={1} max={168} value={form.cache_hours} onChange={e => setForm({ ...form, cache_hours: Number(e.target.value) })} /></Field>
      </div>
    </>}
    {!!(form.app_id || state?.opId || state?.delivery?.pending || state?.delivery?.failed) && <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-subtle/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">{state?.opId && <a className="font-medium text-fg hover:underline" href={`#/engine/op/${state.opId}`}>View operation →</a>}{!!state?.delivery?.pending && <span className="tabular-nums">{state.delivery.pending} queued</span>}{!!state?.delivery?.failed && <span className="tabular-nums text-danger">{state.delivery.failed} failed</span>}</div>
      {!!form.app_id && <Btn variant="primary" loading={busy} onClick={() => apply()}>Save settings</Btn>}
    </div>}
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
  const on = !!(state && form.enabled && state.available);
  return <Card className="overflow-hidden">
    <CardHeader icon={<Bell size={15} />} title="Notifications" description="Alerts delivered to your ntfy client" actions={state ? <Badge tone={on ? "success" : "neutral"}>{on ? "On" : "Off"}</Badge> : undefined} />
    {error && <div className="px-4 pt-4"><InlineNotice tone="danger">{error}</InlineNotice></div>}
    {!state ? <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted"><Spinner /> Loading notifications…</div> : <>
      {!state.available && <div className="px-4 pt-4"><InlineNotice tone="warning">Shared notifications are unavailable. Enable them in Settings → Panel.</InlineNotice></div>}
      <div className="px-4">
        <ToggleRow label="Send me OCD alerts" checked={form.enabled} disabled={!state.available && !form.enabled} onChange={enabled => setForm({ ...form, enabled })} />
        {([['app', 'Unhealthy apps'], ['delivery', 'Failed deployments'], ['disk', 'Disk pressure'], ['backup', 'Panel backups']] as const).map(([key, label]) => <ToggleRow key={key} label={label} checked={form.events.includes(key)} disabled={!form.enabled} onChange={checked => setForm({ ...form, events: checked ? [...form.events, key] : form.events.filter(k => k !== key) })} />)}
        <ToggleRow label="Recovery notices" checked={form.recovery} disabled={!form.enabled} onChange={recovery => setForm({ ...form, recovery })} />
      </div>
      <div className="flex justify-end gap-2 border-t bg-subtle/40 px-4 py-3"><Btn variant="primary" loading={busy} onClick={() => action(async () => { await put("/api/auth/notifications", form); setSecret(null); await load(); showToast("Notification preferences saved", "success"); })}>Save preferences</Btn></div>
      {state.connection && <div className="border-t">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4"><div className="flex items-center gap-2"><Server size={14} className="text-muted" /><h3 className="text-sm font-semibold text-fg">Connect your ntfy client</h3></div><a href={state.connection.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-fg-dim hover:text-fg hover:underline">Open server <ExternalLink size={13} /></a></div>
        <div className="mx-4 mb-4 mt-3 rounded-lg border bg-canvas/50 px-3"><ConnectionRow label="Server" value={state.connection.url} /><ConnectionRow label="Topic" value={state.connection.topic} /><ConnectionRow label="User" value={state.connection.username} />{secret && <ConnectionRow label="Password" value={secret.password} />}</div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-subtle/40 px-4 py-3"><Btn size="xs" disabled={busy} onClick={() => action(async () => { if (secret) setSecret(null); else setSecret(await post("/api/auth/notifications/credentials", {})); })}>{secret ? "Hide password" : "Show password"}</Btn><Btn size="xs" disabled={busy || !state.available} onClick={() => action(async () => { await post("/api/auth/notifications/test", {}); showToast("Test notification queued", "success"); })}><Send size={12} /> Send test</Btn><Btn size="xs" variant="ghost" disabled={busy} onClick={() => action(load)}><RefreshCw size={12} /> Refresh</Btn>{state.delivery && <span className="ml-auto text-xs text-muted">{state.delivery.sent_at ? "Delivered" : state.delivery.error || "Queued"}</span>}</div>
      </div>}
    </>}
  </Card>;
}
