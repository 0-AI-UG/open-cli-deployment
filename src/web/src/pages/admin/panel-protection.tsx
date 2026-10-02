import { useEffect, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { Card, CardHeader, Btn, Field, Badge, Table, EmptyState, InlineNotice, Spinner, humanize, showToast } from "../../components/ui.tsx";

import { NeoSelect } from "../../components/neo-select.tsx";
import { AlertTriangle, Archive, Download, KeyRound, RefreshCw, Settings2, ShieldCheck } from "lucide-react";

type Form = { backup_enabled: boolean; backup_bucket: string; backup_prefix: string; backup_retention: number };
type State = Form & {
  recovery_key_configured: boolean; storage_configured: boolean; recovery_pending: boolean; pending_operations: number;
  backups: { id: string; created_at: number; status: string; bucket: string; object_key: string; size_bytes: number; error: string }[];
};
export function PanelProtection() {
  const [state, setState] = useState<State | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [recoveryKey, setRecoveryKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [resumeOps, setResumeOps] = useState(false);
  const [bucketList, setBucketList] = useState<{ names: string[]; error: string } | null>(null);
  const [bucketRefresh, setBucketRefresh] = useState(0);
  const configured = !!(state?.storage_configured && state.recovery_key_configured && state.backup_bucket);
  const showSetup = editing || !configured;
  useEffect(() => {
    if (!showSetup) return;
    let cancelled = false;
    setBucketList(null);
    void get("/api/resources/buckets")
      .then((result: { configured: boolean; buckets: { name: string }[] }) => {
        if (cancelled) return;
        setBucketList({ names: result.buckets.map(b => b.name), error: result.configured ? "" : "Configure Hetzner Object Storage credentials in Admin → Hetzner." });
      })
      .catch(() => {
        if (!cancelled) setBucketList({ names: [], error: "Could not load buckets. Check the Hetzner Object Storage credentials and permission to list buckets, then retry." });
      });
    return () => { cancelled = true; };
  }, [showSetup, bucketRefresh]);
  const load = async (reset = false) => {
    const s = await get("/api/admin/protection");
    setState(s);
    setForm(f => !f || reset ? { backup_enabled: s.backup_enabled, backup_bucket: s.backup_bucket, backup_prefix: s.backup_prefix, backup_retention: s.backup_retention } : f);
  };
  useEffect(() => { void load().catch(e => setError(e.message)); const timer = setInterval(() => void load().catch(() => {}), 10000); return () => clearInterval(timer); }, []);
  const action = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); } finally { setBusy(false); } };
  if (!form || !state) return <Card className="p-4">{error ? <InlineNotice tone="danger">{error}</InlineNotice> : <div className="flex items-center gap-2 text-sm text-muted"><Spinner /> Loading panel protection…</div>}</Card>;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm({ ...form, [key]: value });
  const bucketsLoading = bucketList === null;
  const buckets = bucketList?.names ?? [];
  const bucketError = bucketList?.error ?? "";
  const validBucket = !bucketsLoading && !bucketError && buckets.includes(form.backup_bucket);
  const canSave = validBucket && state.recovery_key_configured;
  const activeBackup = state.backups.some(b => b.status === "pending" || b.status === "running");
  const save = async () => {
    await put("/api/admin/protection", form);
    await load(true); setEditing(false); setRecoveryKey(""); showToast("Backup settings saved", "success");
  };
  const downloadKey = () => {
    const url = URL.createObjectURL(new Blob([recoveryKey + "\n"], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "ocd-panel-recovery-key.txt"; a.click(); URL.revokeObjectURL(url);
  };
  const statusLabel = (status: string) => status === "complete" ? "Completed" : status === "pending" ? "Queued" : humanize(status);
  return <div className="space-y-6">
    {error && <InlineNotice tone="danger">{error}</InlineNotice>}
    {state.recovery_pending && <Card className="overflow-hidden border-warning/40">
      <CardHeader className="bg-warning/5" icon={<AlertTriangle size={15} className="text-warning" />} title="Recovery paused" description="Confirm the original panel is down before automation resumes." actions={<Badge tone="warning">{state.pending_operations} saved operations</Badge>} />
      <div className="px-4">
        <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 border-b py-2"><span className="text-sm font-medium text-fg">Original panel stopped</span><input type="checkbox" checked={stopped} onChange={e => setStopped(e.target.checked)} /></label>
        <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 py-2"><span className="text-sm font-medium text-fg">Resume saved operations</span><input type="checkbox" checked={resumeOps} onChange={e => setResumeOps(e.target.checked)} /></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-subtle/40 px-4 py-3"><span className="text-xs text-muted">Backups stay off until you enable them.</span><Btn variant="primary" disabled={busy || !stopped || !resumeOps} onClick={() => action(async () => { await post("/api/admin/protection/resume", { original_panel_stopped: stopped, resume_saved_operations: resumeOps }); await load(true); showToast("Server access verified; automation resumed", "success"); })}>Verify servers and resume</Btn></div>
    </Card>}
    <Card className="overflow-hidden">
      <CardHeader
        icon={<ShieldCheck size={15} />}
        title={showSetup ? "Set up panel backups" : "Panel backups"}
        description="Encrypted backups of panel state, credentials, and SSH keys."
        actions={!showSetup ? <>
          <Btn disabled={busy} onClick={() => { setEditing(true); setError(""); }}><Settings2 size={14} /> Edit settings</Btn>
          <Btn variant="primary" disabled={busy || state.recovery_pending || activeBackup} onClick={() => action(async () => { await post("/api/admin/protection/backup", {}); showToast("Backup queued", "success"); })}><Archive size={14} />{activeBackup ? "Backup in progress" : "Back up now"}</Btn>
        </> : undefined}
      />
      {showSetup ? <>
        <p className="px-4 pt-4 text-sm text-fg-dim">Choose where to store your backups and save a recovery key. Application databases and volumes are excluded.</p>
        <section className="px-4 pt-5">
          <h4 className="text-sm font-semibold text-fg">Storage destination</h4>
          <Field divider align="start" label="Bucket" hint="Buckets in your Hetzner Object Storage account.">
            <div className="space-y-2">
              <NeoSelect value={validBucket ? form.backup_bucket : ""} onChange={value => set("backup_bucket", value)} options={buckets.map(name => ({ value: name, label: name }))} disabled={busy || bucketsLoading || !!bucketError || buckets.length === 0} placeholder={bucketsLoading ? "Loading buckets…" : bucketError ? "Buckets unavailable" : buckets.length === 0 ? "No buckets found" : "Select a bucket"} />
              {bucketError && <p role="alert" className="text-xs text-danger">{bucketError}</p>}
              {!bucketsLoading && !bucketError && form.backup_bucket && !validBucket && <p role="alert" className="text-xs text-danger">The saved bucket “{form.backup_bucket}” is unavailable. Select an existing bucket.</p>}
              {!bucketsLoading && !bucketError && buckets.length === 0 && <p className="text-xs text-muted">Create a bucket in <a href="#/resources" className="text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">Resources</a>, then refresh this list.</p>}
              <Btn size="xs" variant="ghost" disabled={busy || bucketsLoading} onClick={() => { setBucketList(null); setBucketRefresh(value => value + 1); }}><RefreshCw size={12} /> {bucketError ? "Retry" : "Refresh buckets"}</Btn>
            </div>
          </Field>
          <Field divider label="Path prefix"><input className="font-mono" disabled={busy} value={form.backup_prefix} onChange={e => set("backup_prefix", e.target.value)} placeholder="ocd-panel" /></Field>
        </section>
        <section className="mx-4 mt-2 border-t pb-4 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h4 className="text-sm font-semibold text-fg">Recovery key</h4><p className="mt-0.5 text-xs text-muted">Keep this key outside the panel. You’ll need it to restore a backup.</p></div>
            <Btn disabled={busy} onClick={() => action(async () => { const r = await post("/api/admin/protection/recovery-key", {}); setRecoveryKey(r.recovery_key); })}><KeyRound size={14} /> {state.recovery_key_configured ? "Show recovery key" : "Create recovery key"}</Btn>
          </div>
          {recoveryKey && <div className="mt-3 space-y-3 rounded-lg border bg-subtle/60 p-3"><code className="block select-all break-all font-mono text-xs text-fg">{recoveryKey}</code><div className="flex flex-wrap gap-2"><Btn size="xs" onClick={downloadKey}><Download size={12} /> Download key</Btn><Btn size="xs" variant="ghost" onClick={() => setRecoveryKey("")}>Hide key</Btn></div></div>}
        </section>
        <section className="mx-4 border-t pt-5">
          <h4 className="text-sm font-semibold text-fg">Schedule & retention</h4>
          <Field divider label="Daily backups"><label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" checked={form.backup_enabled} disabled={busy || !canSave || state.recovery_pending} onChange={e => set("backup_enabled", e.target.checked)} /> Back up every 24 hours</label></Field>
          <Field divider label="Backups to retain" hint="Older successful backups are removed after a new backup is verified."><input type="number" min={1} max={90} disabled={busy} value={form.backup_retention} onChange={e => set("backup_retention", Number(e.target.value))} /></Field>
        </section>
        <div className="mt-2 flex flex-wrap justify-end gap-2 border-t bg-subtle/40 px-4 py-3">
          {configured && <Btn disabled={busy} onClick={() => { setForm({ backup_enabled: state.backup_enabled, backup_bucket: state.backup_bucket, backup_prefix: state.backup_prefix, backup_retention: state.backup_retention }); setEditing(false); setRecoveryKey(""); setError(""); }}>Cancel</Btn>}
          <Btn variant="primary" loading={busy} disabled={!canSave} onClick={() => action(save)}>{configured ? "Save settings" : "Finish setup"}</Btn>
        </div>
      </> : <>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-canvas/50 px-4 py-3">
          <div className="min-w-0"><p className="text-xs text-muted">Storage destination</p><p className="mt-0.5 break-all font-mono text-xs text-fg">s3://{state.backup_bucket}/{state.backup_prefix}</p></div>
          <div className="flex flex-wrap items-center gap-3"><span className="text-xs text-muted">Retaining {state.backup_retention} successful backups</span><Badge tone={state.backup_enabled ? "success" : "neutral"}>{state.backup_enabled ? "Daily backups on" : "Manual backups"}</Badge></div>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-4"><h4 className="text-sm font-semibold text-fg">Backup history</h4><span className="text-xs text-muted"><span className="tabular-nums">{state.backups.length}</span> records · updates automatically</span></div>
        {state.backups.length === 0 ? <EmptyState icon={Archive} message="No backups yet" description={`Create your first backup with “Back up now”${state.backup_enabled ? ", or wait for the daily schedule." : "."}`} /> : <div className="border-t"><Table headers={["Created", "Status", "Size", "Backup location"]}>
          {state.backups.map(b => <tr key={b.id}>
            <td className="whitespace-nowrap text-xs tabular-nums text-fg-dim">{new Date(b.created_at).toLocaleString()}</td>
            <td><Badge tone={b.status === "complete" ? "success" : b.status === "failed" ? "danger" : b.status === "pending" || b.status === "running" ? "warning" : "neutral"}>{statusLabel(b.status)}</Badge></td>
            <td className="whitespace-nowrap font-mono text-xs tabular-nums text-fg-dim">{b.size_bytes ? `${(b.size_bytes / 1024 / 1024).toFixed(2)} MB` : "—"}</td>
            <td className="min-w-48"><code className="select-all break-all font-mono text-xs text-fg-dim">s3://{b.bucket}/{b.object_key}</code>{b.error && <p className="mt-1 break-words text-xs text-danger">{b.error}</p>}</td>
          </tr>)}
        </Table></div>}
      </>}
    </Card>
  </div>;
}
