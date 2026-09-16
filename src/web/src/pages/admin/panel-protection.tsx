import { useEffect, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { Card, Btn, Field, Badge, Table, showToast } from "../../components/ui.tsx";

import { NeoSelect } from "../../components/neo-select.tsx";
import { Archive, Download, Settings2, ShieldCheck } from "lucide-react";

type Form = { backup_connection: string; backup_enabled: boolean; backup_bucket: string; backup_prefix: string; backup_retention: number; alert_enabled: boolean; alert_recipient: string; alert_sender: string };
type State = Form & {
  storage_connections: Array<{ id: string; name: string; region: string }>;
  resend_configured: boolean; recovery_key_configured: boolean; storage_configured: boolean; recovery_pending: boolean; pending_operations: number;
  backups: { id: string; created_at: number; status: string; bucket: string; object_key: string; size_bytes: number; error: string }[];
  deliveries: { id: string; sent_at: number | null; attempts: number; error: string }[];
  alerts: { key: string; title: string; resolved_at: number | null }[];
};
export function PanelProtection() {
  const [state, setState] = useState<State | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [resumeOps, setResumeOps] = useState(false);
  const load = async (reset = false) => {
    const s = await get("/api/admin/protection");
    setState(s);
    setForm(f => !f || reset ? { backup_connection: s.backup_connection, backup_enabled: s.backup_enabled, backup_bucket: s.backup_bucket, backup_prefix: s.backup_prefix, backup_retention: s.backup_retention, alert_enabled: s.alert_enabled, alert_recipient: s.alert_recipient, alert_sender: s.alert_sender } : f);
  };
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = setInterval(() => void load().catch(() => {}), 10000); return () => clearInterval(timer); }, []);
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); } finally { setBusy(false); } };
  if (!form || !state) return <Card className="p-5">{error || "Loading panel protection…"}</Card>;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const configured = state.storage_configured && state.recovery_key_configured && !!state.backup_bucket;
  const showSetup = editing || !configured;
  const canSave = !!form.backup_bucket.trim() && state.storage_connections.some(c => c.id === form.backup_connection) && state.recovery_key_configured;
  const activeBackup = state.backups.some(b => b.status === "pending" || b.status === "running");
  const inputClass = "w-full border-2 border-fg bg-bg-raised px-3 py-2 font-mono text-[11px]";
  const save = async () => {
    await put("/api/admin/protection", { ...form, ...(apiKey ? { resend_key: apiKey } : {}) });
    setApiKey("");
    await load(true); setEditing(false); setRecoveryKey(""); showToast("Backup settings saved", "success");
  };
  const downloadKey = () => {
    const url = URL.createObjectURL(new Blob([recoveryKey + "\n"], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "ocd-panel-recovery-key.txt"; a.click(); URL.revokeObjectURL(url);
  };
  return <div className="space-y-4">
    {error && <div role="alert" className="border-2 border-fg p-3 text-sm">{error}</div>}
    {state.recovery_pending && <Card className="p-5 space-y-3">
      <h3 className="font-bold">Panel recovery is paused</h3>
      <p>Verify access to existing servers before automation resumes. {state.pending_operations} saved operations may continue. Keep the original panel stopped.</p>
      <label className="block"><input type="checkbox" checked={stopped} onChange={e => setStopped(e.target.checked)} /> The original panel is stopped</label>
      <label className="block"><input type="checkbox" checked={resumeOps} onChange={e => setResumeOps(e.target.checked)} /> Resume saved operations and reconciliation</label>
      <Btn disabled={busy || !stopped || !resumeOps} onClick={() => action(async () => { await post("/api/admin/protection/resume", { original_panel_stopped: stopped, resume_saved_operations: resumeOps }); await load(true); showToast("Server access verified; automation resumed", "success"); })}>Verify servers and resume</Btn>
      <p className="text-sm">Backups stay disabled after restore until you enable them again.</p>
    </Card>}
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-fg p-5">
        <div className="flex items-start gap-3">
          <div className="border-2 border-fg bg-accent p-2 shadow-neo-sm"><ShieldCheck size={20} /></div>
          <div>
            <h3 className="font-mono text-sm font-bold uppercase tracking-wide">{showSetup ? "Set up panel backups" : "Panel backups"}</h3>
            <p className="mt-1 text-xs text-muted">Encrypted backups of panel state, credentials, and SSH keys.</p>
          </div>
        </div>
        {!showSetup && <div className="flex flex-wrap gap-2">
          <Btn disabled={busy} onClick={() => { setEditing(true); setError(""); }}><Settings2 size={12} /> Edit settings</Btn>
          <Btn variant="primary" disabled={busy || state.recovery_pending || activeBackup} onClick={() => action(async () => { await post("/api/admin/protection/backup", {}); showToast("Backup queued", "success"); })}><Archive size={12} />{activeBackup ? "Backup in progress" : "Back up now"}</Btn>
        </div>}
      </div>
      {showSetup ? <div className="p-5 space-y-6">
        <p className="text-xs text-muted">Choose where to store your backups and save a recovery key. Application databases and volumes are excluded.</p>
        <section className="space-y-3">
          <h4 className="font-mono text-[10px] font-bold uppercase tracking-wider">01 / Storage destination</h4>
          {state.storage_connections.length === 0 && <p className="border-2 border-fg bg-alt p-3 text-xs">Add an S3-compatible connection in Admin → Providers to get started.</p>}
          <Field label="Storage connection"><NeoSelect value={form.backup_connection} onChange={value => set("backup_connection", value)} placeholder="Select S3 connection" disabled={busy || state.storage_connections.length === 0} options={state.storage_connections.map(c => ({ value: c.id, label: `${c.name}${c.region ? ` · ${c.region}` : ""}` }))} /></Field>
          <Field label="Bucket" hint="Use an existing bucket accessible by this connection."><input className={inputClass} disabled={busy} value={form.backup_bucket} onChange={e => set("backup_bucket", e.target.value)} placeholder="my-panel-backups" /></Field>
          <Field label="Path prefix"><input className={inputClass} disabled={busy} value={form.backup_prefix} onChange={e => set("backup_prefix", e.target.value)} placeholder="ocd-panel" /></Field>
        </section>
        <section className="space-y-3 border-t border-fg/20 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h4 className="font-mono text-[10px] font-bold uppercase tracking-wider">02 / Recovery key</h4><p className="mt-2 text-xs text-muted">Keep this key outside the panel. You’ll need it to restore a backup.</p></div>
            <Btn disabled={busy} onClick={() => action(async () => { const r = await post("/api/admin/protection/recovery-key", {}); setRecoveryKey(r.recovery_key); })}>{state.recovery_key_configured ? "Show recovery key" : "Create recovery key"}</Btn>
          </div>
          {recoveryKey && <div className="space-y-3 border-2 border-fg bg-alt p-4"><code className="block break-all select-all font-mono text-xs">{recoveryKey}</code><div className="flex flex-wrap gap-2"><Btn onClick={downloadKey}><Download size={12} /> Download key</Btn><Btn onClick={() => setRecoveryKey("")}>Hide key</Btn></div></div>}
        </section>
        <section className="space-y-3 border-t border-fg/20 pt-5">
          <h4 className="font-mono text-[10px] font-bold uppercase tracking-wider">03 / Schedule & retention</h4>
          <Field label="Daily backups"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.backup_enabled} disabled={busy || !canSave || state.recovery_pending} onChange={e => set("backup_enabled", e.target.checked)} /> Back up every 24 hours</label></Field>
          <Field label="Backups to retain" hint="Older successful backups are removed after a new backup is verified."><input className={inputClass} type="number" min={1} max={90} disabled={busy} value={form.backup_retention} onChange={e => set("backup_retention", Number(e.target.value))} /></Field>
        </section>
        <div className="flex flex-wrap gap-2 border-t border-fg/20 pt-5">
          <Btn variant="primary" loading={busy} disabled={!canSave} onClick={() => action(save)}>{configured ? "Save settings" : "Finish setup"}</Btn>
          {configured && <Btn disabled={busy} onClick={() => { setForm({ backup_connection: state.backup_connection, backup_enabled: state.backup_enabled, backup_bucket: state.backup_bucket, backup_prefix: state.backup_prefix, backup_retention: state.backup_retention, alert_enabled: state.alert_enabled, alert_recipient: state.alert_recipient, alert_sender: state.alert_sender }); setEditing(false); setRecoveryKey(""); setError(""); }}>Cancel</Btn>}
        </div>
      </div> : <>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-fg/20 bg-alt px-5 py-4">
          <div className="min-w-0"><p className="font-mono text-[10px] font-bold uppercase tracking-wider">Storage destination</p><p className="mt-1 break-all font-mono text-xs">s3://{state.backup_bucket}/{state.backup_prefix}</p></div>
          <div className="flex flex-wrap items-center gap-3"><span className="text-xs text-muted">Retaining {state.backup_retention} successful backups</span><Badge tone={state.backup_enabled ? "success" : "neutral"}>{state.backup_enabled ? "Daily backups on" : "Manual backups"}</Badge></div>
        </div>
        <div className="p-5">
          <div className="mb-4 flex items-center justify-between"><h4 className="font-mono text-[10px] font-bold uppercase tracking-wider">Backup history</h4><span className="font-mono text-[10px] text-muted">{state.backups.length} records · updates automatically</span></div>
          {state.backups.length === 0 ? <div className="border-2 border-dashed border-fg/25 px-4 py-10 text-center"><Archive size={28} className="mx-auto mb-3 text-muted" /><p className="text-sm font-bold">No backups yet</p><p className="mt-2 text-xs text-muted">Create your first backup with “Back up now”{state.backup_enabled ? ", or wait for the daily schedule." : "."}</p></div> : <div className="overflow-x-auto"><Table headers={["Created", "Status", "Size", "Backup location"]}>
            {state.backups.map(b => <tr key={b.id} className="border-t border-fg/15">
              <td className="whitespace-nowrap px-3 py-3 font-mono text-[10px]">{new Date(b.created_at).toLocaleString()}</td>
              <td className="px-3 py-3"><Badge tone={b.status === "complete" ? "success" : b.status === "failed" ? "danger" : b.status === "pending" || b.status === "running" ? "warning" : "neutral"}>{b.status === "complete" ? "Completed" : b.status === "pending" ? "Queued" : b.status}</Badge></td>
              <td className="whitespace-nowrap px-3 py-3 font-mono text-[10px]">{b.size_bytes ? `${(b.size_bytes / 1024 / 1024).toFixed(2)} MB` : "—"}</td>
              <td className="min-w-48 px-3 py-3"><code className="break-all select-all text-[10px]">s3://{b.bucket}/{b.object_key}</code>{b.error && <p className="mt-1 break-words text-xs text-accent-red">{b.error}</p>}</td>
            </tr>)}
          </Table></div>}
        </div>
      </>}
    </Card>
    <Card className="p-5 space-y-3">
      <h3 className="font-bold">Email alerts</h3>
      <p className="text-sm">Deployment failures, unhealthy apps, failed or overdue panel backups, and low disk space. One opening email and one recovery email per incident.</p>
      <Field label="Resend API key"><input type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={state.resend_configured ? "Configured — leave blank to keep" : "re_…"} /></Field>
      <Field label="Recipient email"><input type="email" value={form.alert_recipient} onChange={e => set("alert_recipient", e.target.value)} /></Field>
      <details><summary>Custom sender (optional)</summary><Field label="Sender email"><input type="email" value={form.alert_sender} onChange={e => set("alert_sender", e.target.value)} placeholder="alerts@your-domain.com" /></Field></details>
      <p className="text-sm">The default Resend test sender sends to your Resend account email. For other recipients, use a sender on your verified domain.</p>
      <label className="block"><input type="checkbox" checked={form.alert_enabled} onChange={e => set("alert_enabled", e.target.checked)} /> Enable email alerts</label>
      <div className="flex gap-2"><Btn disabled={busy} onClick={() => action(save)}>Save settings</Btn><Btn disabled={busy || !form.alert_enabled} onClick={() => action(async () => { await save(); const r = await post("/api/admin/protection/test-email", {}); if (!r.ok) throw new Error(r.error || "Test email is queued"); showToast("Test email sent", "success"); })}>Send test email</Btn></div>
      {state.alerts.map(a => <p key={a.key} className="text-sm">{a.resolved_at ? "Resolved" : "Active"}: {a.title}</p>)}
      {state.deliveries.length > 0 && <details><summary>Email delivery status</summary>{state.deliveries.map(d => <p key={d.id} className="text-sm">{d.sent_at ? "Sent" : d.attempts >= 12 ? "Failed" : "Pending"}{d.error ? ` — ${d.error}` : ""}</p>)}</details>}
    </Card>
  </div>;
}
