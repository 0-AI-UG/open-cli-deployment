import { useEffect, useState } from "react";
import { get, put, post } from "../api/client.ts";
import { Card, Btn, showToast } from "./ui.tsx";
import type { NtfyPreferences, NtfySettings } from "../../../shared/ntfy-schema.ts";

export function AdminNtfySettings() {
  const [form, setForm] = useState<NtfySettings>({ enabled: false, domain: "", alerts: true, apps: true, ios_push: false, cache_hours: 24, memory_mb: 128, cpu_limit: 0.5 });
  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { get("/api/admin/ntfy").then(s => { setState(s); if (s.settings) setForm(s.settings); }).catch(e => setError(e.message)); }, []);
  useEffect(() => { const timer = window.setInterval(() => { get("/api/admin/ntfy").then(setState).catch(() => {}); }, 10000); return () => window.clearInterval(timer); }, []);
  async function save() {
    setBusy(true); setError("");
    try { const result = await put("/api/admin/ntfy", form); showToast("ntfy configuration queued", "success"); setState({ ...state, status: "pending", opId: result.opId }); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <Card className="p-5 space-y-4">
    <h2 className="font-semibold">Shared notifications · ntfy</h2>
    <p className="text-sm text-muted">OCD runs a private notification server on the panel host. Users subscribe to platform alerts; hosted apps get isolated topics and credentials.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <label className="flex gap-2"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Enable shared ntfy</label>
    <label className="block">HTTPS domain<input className="block w-full" value={form.domain} placeholder="notify.example.com" onChange={e => setForm({ ...form, domain: e.target.value })} /></label>
    <p className="text-sm text-muted">Point this domain to the panel's ingress address. OCD provisions HTTPS automatically.</p>
    <label className="flex gap-2"><input type="checkbox" checked={form.alerts} onChange={e => setForm({ ...form, alerts: e.target.checked })} /> Allow platform alerts in Account → Notifications</label>
    <label className="flex gap-2"><input type="checkbox" checked={form.apps} onChange={e => setForm({ ...form, apps: e.target.checked })} /> Allow hosted app notification bindings</label>
    <label className="block">RAM limit (MiB)<input type="number" min={64} max={4096} value={form.memory_mb} onChange={e => setForm({ ...form, memory_mb: Number(e.target.value) })} /></label>
    <label className="block">CPU limit (cores)<input type="number" min={0.1} max={4} step={0.1} value={form.cpu_limit} onChange={e => setForm({ ...form, cpu_limit: Number(e.target.value) })} /></label>
    <label className="block">Message retention (hours)<input type="number" min={1} max={168} value={form.cache_hours} onChange={e => setForm({ ...form, cache_hours: Number(e.target.value) })} /></label>
    <label className="flex gap-2"><input type="checkbox" checked={form.ios_push} onChange={e => setForm({ ...form, ios_push: e.target.checked })} /> Enable instant iOS push through ntfy.sh</label>
    <p className="text-sm text-muted">The optional iOS relay receives wake-up requests; notification content stays on this server.</p>
    <p className="text-sm">Service: {state?.status || "Loading…"}{state?.checked_at && ` · Checked ${new Date(state.checked_at).toLocaleString()}`}</p>
    {state?.delivery?.pending > 0 && <p className="text-sm">Queued messages: {state.delivery.pending} · Exhausted retries: {state.delivery.failed || 0}</p>}
    <div className="flex gap-3 items-center"><Btn loading={busy} disabled={!state || !form.domain} onClick={save}>Save and apply</Btn>{state?.opId && <a href={`#/engine/op/${state.opId}`}>View operation</a>}</div>
    <p className="text-sm text-muted">Disabling stops the service and retains its data. Platform alerts use a durable retry queue. The service shares the panel host's availability.</p>
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
