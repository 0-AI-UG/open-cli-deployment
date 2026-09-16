import { useEffect, useState } from "react";
import { get, put, post } from "../api/client.ts";
import { Card, Btn, Field, showToast } from "./ui.tsx";
import { NeoSelect } from "./neo-select.tsx";
import type { NtfyPreferences, NtfySettings } from "../../../shared/ntfy-schema.ts";

const defaultSettings: NtfySettings = { enabled: true, app_id: null, alerts: true, apps: true, ios_push: false, cache_hours: 24 };
type ServiceState = { settings: NtfySettings | null; app: { id: number; name: string; domain: string; status: string } | null; apps: { id: number; name: string }[]; servers: { id: number; name: string }[]; opId: number | null; delivery: { pending: number; failed: number } };
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
  return <Card className="p-5 space-y-4">
    <h2 className="font-mono text-xs font-bold uppercase tracking-wider">Shared notifications</h2>
    <p className="text-sm text-muted">Private OCD alerts and notification topics for your apps, powered by ntfy.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!state ? <p className="text-sm text-muted">Loading…</p> : state.app ? <>
      <div className="flex items-center justify-between gap-3 border-2 border-fg p-3">
        <div><a className="font-bold underline" href={`#/apps/${state.app.id}`}>{state.app.name}</a><p className="text-xs text-muted">{state.app.domain}</p></div>
        <span className="font-mono text-xs">{state.app.status}</span>
      </div>
      <p className="text-sm text-muted">Manage deployments, logs, storage, resources, and start or pause the service from its app page.</p>
    </> : <>
      <Field label="App name"><input value={create.name} onChange={e => setCreate({ ...create, name: e.target.value })} /></Field>
      <Field label="HTTPS domain" hint="Point this domain to the selected server's ingress address. OCD provisions HTTPS."><input value={create.domain} placeholder="notify.example.com" onChange={e => setCreate({ ...create, domain: e.target.value })} /></Field>
      <Field label="Server"><NeoSelect value={String(create.server_id || "")} options={state.servers.map(s => ({ value: String(s.id), label: s.name }))} onChange={v => setCreate({ ...create, server_id: Number(v) })} placeholder="Select a server" /></Field>
      <p className="text-xs text-muted">Creates a regular app with persistent storage, a 128 MiB memory limit, and a 0.5 CPU limit.</p>
      <Btn loading={busy} disabled={!create.domain || !create.server_id} onClick={() => apply(true)}>Create ntfy app</Btn>
      {!!state.apps.length && <Field label="Use an existing ntfy app"><NeoSelect value={String(form.app_id || "")} options={state.apps.map(a => ({ value: String(a.id), label: a.name }))} onChange={v => setForm({ ...form, app_id: Number(v) })} placeholder="Select an app" /></Field>}
    </>}
    {!!form.app_id && <>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Enable notification integration</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.alerts} onChange={e => setForm({ ...form, alerts: e.target.checked })} /> Allow OCD event alerts</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.apps} onChange={e => setForm({ ...form, apps: e.target.checked })} /> Allow hosted app notification bindings</label>
      <details><summary className="cursor-pointer font-mono text-xs font-bold">Delivery options</summary>
        <Field label="Message retention (hours)"><input type="number" min={1} max={168} value={form.cache_hours} onChange={e => setForm({ ...form, cache_hours: Number(e.target.value) })} /></Field>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.ios_push} onChange={e => setForm({ ...form, ios_push: e.target.checked })} /> Instant iOS push through ntfy.sh</label>
        <p className="mt-2 text-xs text-muted">The optional iOS relay receives wake-up requests; notification content stays on your server.</p>
      </details>
      <Btn loading={busy} onClick={() => apply()}>Save integration</Btn>
    </>}
    {state?.opId && <a className="block text-xs underline" href={`#/engine/op/${state.opId}`}>View configuration operation</a>}
    {!!state?.delivery?.pending && <p className="text-xs text-muted">Queued messages: {state.delivery.pending} · Exhausted retries: {state.delivery.failed || 0}</p>}
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
  return <Card className="p-5 space-y-4">
    <h2 className="font-semibold">Notifications</h2>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!state ? <p>Loading…</p> : <>
      {!state.available && <p className="text-sm text-muted">An administrator must enable shared ntfy alerts first.</p>}
      <label className="flex gap-2"><input type="checkbox" disabled={!state.available && !form.enabled} checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Send me OCD alerts</label>
      <div className="flex flex-wrap gap-4">{([['app', 'Unhealthy apps'], ['delivery', 'Failed deployments'], ['disk', 'Disk pressure'], ['backup', 'Panel backups']] as const).map(([key, label]) => <label key={key} className="flex gap-2"><input type="checkbox" checked={form.events.includes(key)} onChange={e => setForm({ ...form, events: e.target.checked ? [...form.events, key] : form.events.filter(k => k !== key) })} />{label}</label>)}</div>
      <label className="flex gap-2"><input type="checkbox" checked={form.recovery} onChange={e => setForm({ ...form, recovery: e.target.checked })} /> Notify me when an incident recovers</label>
      <p className="text-sm text-muted">App alerts follow your app permissions. Fleet, deployment, and backup alerts are currently available to administrators.</p>
      <Btn loading={busy} onClick={() => action(async () => { await put("/api/auth/notifications", form); setSecret(null); await load(); showToast("Notification preferences saved; access is being applied", "success"); })}>Save preferences</Btn>
      {state.connection && <div className="space-y-2 text-sm">
        <p>Add this server and topic in the ntfy mobile app or web client. Use the username and password below to sign in.</p>
        <p>Server: <a href={state.connection.url} target="_blank" rel="noreferrer">{state.connection.url}</a></p>
        <p>Topic: <code className="select-all break-all">{state.connection.topic}</code></p>
        <p>Username: <code className="select-all break-all">{state.connection.username}</code></p>
        {secret && <p>Password: <code className="select-all break-all">{secret.password}</code></p>}
        <div className="flex gap-2"><Btn disabled={busy} onClick={() => action(async () => { if (secret) setSecret(null); else setSecret(await post("/api/auth/notifications/credentials", {})); })}>{secret ? "Hide password" : "Show password"}</Btn><Btn disabled={busy || !state.available} onClick={() => action(async () => { await post("/api/auth/notifications/test", {}); showToast("Test queued; delivery runs within the next service tick", "success"); })}>Send test</Btn><Btn disabled={busy} onClick={() => action(load)}>Refresh status</Btn></div>
        {state.delivery && <p>Last notification: {state.delivery.sent_at ? "Delivered" : state.delivery.error || "Queued"}</p>}
      </div>}
    </>}
  </Card>;
}
