import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { get, post } from "../api/client.ts";
import { useHasPermission } from "../stores/auth.ts";
import { Btn, Card, Field, PageHeader, PageShell, PageState, confirm, showToast } from "../components/ui.tsx";
import type { DeploymentRecord, PanelApp } from "../types.ts";

type PanelState = { panel: PanelApp | null; server: { name: string; ipv4: string } | null; deploy_log: string };
type MainRelease = { commit: string; image: string; upToDate: boolean };

export function PanelPage() {
  const canView = useHasPermission("panel.view");
  const canManage = useHasPermission("panel.manage");
  const [state, setState] = useState<PanelState | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [logs, setLogs] = useState("");
  const [release, setRelease] = useState<MainRelease | null>(null);
  const [image, setImage] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [panel, history, recentLogs] = await Promise.all([
        get("/api/admin/panel") as Promise<PanelState>,
        (get("/api/admin/panel/deployments") as Promise<DeploymentRecord[]>).catch(() => []),
        (get("/api/admin/panel/logs?tail=200") as Promise<{ logs: string }>).catch(() => ({ logs: "" })),
      ]);
      setState(panel);
      setDeployments(history);
      setLogs(recentLogs.logs || "");
      setImage((current) => current || panel.panel?.image_ref || "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load panel status");
    }
  }, []);

  const refreshRelease = useCallback(async () => {
    try { setRelease(await get("/api/admin/panel/latest-release") as MainRelease); }
    catch { setRelease(null); }
  }, []);

  useEffect(() => {
    if (!canView) return;
    void refresh();
    if (canManage) void refreshRelease();
  }, [canView, canManage, refresh, refreshRelease]);

  async function redeploy(target: { image: string; commit?: string }, latest: boolean) {
    if (!await confirm("Redeploy panel", `Deploy ${target.image}? The panel will briefly become unavailable.`, true)) return;
    setBusy(true);
    try {
      const result = await post(latest ? "/api/admin/panel/latest-release" : "/api/admin/panel/redeploy", target);
      if (!result?.ok) throw new Error(result?.error || "Panel redeploy failed");
      showToast("Panel redeploy dispatched; refresh after it returns", "success");
      setTimeout(() => { void refresh(); void refreshRelease(); }, 5000);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "Panel redeploy failed", "error");
    } finally { setBusy(false); }
  }

  if (!canView) return <PageState kind="error" title="Panel access required" />;
  if (!state && !error) return <PageState title="Loading panel" />;
  return <PageShell>
    <PageHeader title="Panel" description="Control plane status and releases." actions={<Btn onClick={() => { void refresh(); if (canManage) void refreshRelease(); }}><RefreshCw size={13} /> Refresh</Btn>} />
    {error && <p role="alert" className="text-accent-red text-xs">{error}</p>}
    {state?.panel && <Card className="p-5 space-y-3">
      <h2 className="font-mono text-sm font-bold uppercase">{state.panel.name} · {state.panel.status}</h2>
      <div className="text-xs space-y-1">
        <div>Domain: <a className="underline" href={`https://${state.panel.domain}`}>{state.panel.domain}</a></div>
        <div>Server: {state.server?.name || "—"}</div>
        <div className="break-all">Image: {state.panel.image_ref || "—"}</div>
      </div>
      {canManage && <div className="border-t-2 border-fg/10 pt-3 space-y-3">
        <h3 className="font-mono text-xs font-bold uppercase">Release panel</h3>
        {release && <p className="text-xs break-all">Latest main: {release.commit.slice(0, 12)} · {release.upToDate ? "currently deployed" : "new image available"}<br />{release.image}</p>}
        <Btn variant="primary" disabled={!release || busy} loading={busy} onClick={() => release && void redeploy({ image: release.image, commit: release.commit }, true)}>
          {release?.upToDate ? "Redeploy current panel" : "Deploy latest main"}
        </Btn>
        <Btn size="xs" variant="ghost" onClick={() => setAdvanced((value) => !value)}>{advanced ? "Hide specific image" : "Advanced: deploy a specific image"}</Btn>
        {advanced && <div className="space-y-2">
          <Field label="Immutable image" align="start"><input value={image} onChange={(event) => setImage(event.target.value)} placeholder="registry/repository@sha256:..." /></Field>
          <Btn disabled={!/@sha256:[a-f0-9]{64}$/i.test(image) || busy} loading={busy} onClick={() => void redeploy({ image: image.trim() }, false)}>Deploy image</Btn>
        </div>}
      </div>}
    </Card>}
    <Card className="p-5 space-y-2">
      <h2 className="font-mono text-xs font-bold uppercase">Recent deployments</h2>
      {deployments.length ? deployments.slice(0, 10).map((item) => <div key={item.id} className="text-xs border-t border-fg/10 pt-2 break-all">
        {item.created_at} · {item.status} · {item.source || "manual"}<br />{item.image_tag || item.image_digest || "—"}
      </div>) : <p className="text-xs text-muted">No deployments recorded.</p>}
    </Card>
    <Card className="p-5 space-y-2">
      <h2 className="font-mono text-xs font-bold uppercase">Panel logs</h2>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-[10px]">{logs || "No logs available."}</pre>
    </Card>
  </PageShell>;
}
