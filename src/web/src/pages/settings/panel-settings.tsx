import { useState, useEffect } from "react";
import { get, post } from "../../api/client.ts";
import { Card, CardHeader, Btn, Badge, DataRow, EmptyState, StatusBadge, CopyButton, showToast, confirm } from "../../components/ui.tsx";
import { History, RefreshCw, Server as ServerIcon } from "lucide-react";
import { PanelProtection } from "./panel-protection.tsx";
import { NtfyServiceSettings } from "../../components/ntfy-settings.tsx";
import { DnsInstructionView } from "../../components/dns-instruction.tsx";
import type { PanelApp, DeploymentRecord } from "../../types.ts";

type LatestPanelRelease = { commit: string; image: string; currentImage: string; upToDate: boolean };

export function PanelSettings() {
  const [panel, setPanel] = useState<PanelApp | null>(null);
  const [server, setServer] = useState<{ id: number; name: string; ipv4: string } | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [latest, setLatest] = useState<LatestPanelRelease | null>(null);
  const [latestError, setLatestError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    get("/api/panel")
      .then((data) => {
        setPanel(data.panel ? { ...data.panel, dns_instruction: data.dns_instruction } : null);
        setServer(data.server);
        if (data.panel) {
          get("/api/panel/latest-release")
            .then((release) => { setLatest(release); setLatestError(""); })
            .catch((error) => { setLatest(null); setLatestError(error instanceof Error ? error.message : "Could not find the latest main image"); });
        }
      })
      .catch(() => {});
    get("/api/panel/deployments").then((data) => setDeployments(data || [])).catch(() => {});
  };

  useEffect(() => { refresh(); }, []);

  // Pushing to main redeploys the panel automatically; this is the manual
  // fallback when that pipeline did not run. There is no CLI equivalent.
  const redeployLatest = async () => {
    if (!latest) return;
    if (!await confirm(
      latest.upToDate ? "Redeploy current panel" : "Redeploy latest main",
      `${latest.upToDate ? "Restart the panel on" : "Redeploy the panel from"} main commit ${latest.commit.slice(0, 12)} using ${latest.image}? The panel will briefly become unavailable.`,
      true,
    )) return;
    setBusy(true);
    try {
      const result = await post("/api/panel/latest-release", { commit: latest.commit, image: latest.image });
      if (!result?.ok) throw new Error(result?.error || "Could not dispatch panel release");
      showToast("Panel redeploy dispatched; wait for it to return, then refresh", "success");
      setTimeout(refresh, 5000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not release panel", "error");
    } finally {
      setBusy(false);
    }
  };

  const image = panel ? deployments.find((d) => d.status === "deployed")?.image_tag || panel.image_ref || "—" : "—";

  return (
    <>
      <PanelProtection />
      <NtfyServiceSettings />
      {!panel ? <Card><EmptyState icon={ServerIcon} message="Not a self-hosted panel" description="This instance is not managed as a self-hosted panel app." /></Card> : (
        <Card className="overflow-hidden">
          <CardHeader icon={<ServerIcon size={15} />} title="Panel (self-hosted)" description="Redeploys automatically when main is pushed" actions={<StatusBadge status={panel.status} />} />
          <div>
            <DataRow label="Domain" mono>
              <a href={`https://${panel.domain}`} target="_blank" rel="noreferrer" className="break-all text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">{panel.domain}</a>
            </DataRow>
            <DataRow label="Server" mono>{server ? `${server.name} (${server.ipv4})` : "—"}</DataRow>
            <DataRow label="Image" mono><span className="min-w-0 break-all">{image}</span>{image !== "—" && <CopyButton text={image} />}</DataRow>
            <DataRow label="Latest main">
              {latest
                ? <span className="flex flex-wrap items-center justify-end gap-2"><code className="font-mono text-xs">{latest.commit.slice(0, 12)}</code><Badge tone={latest.upToDate ? "success" : "info"}>{latest.upToDate ? "deployed" : "not deployed yet"}</Badge></span>
                : <span className="text-xs text-danger">{latestError || "—"}</span>}
            </DataRow>
          </div>
          {panel.dns_instruction && <div className="border-t p-4"><DnsInstructionView value={panel.dns_instruction} /></div>}
          {latest && !latest.upToDate && (
            <div className="flex justify-end border-t bg-subtle/40 px-4 py-3">
              <Btn variant="primary" loading={busy} onClick={redeployLatest}><RefreshCw size={14} /> Redeploy latest main</Btn>
            </div>
          )}
          {deployments.length > 0 && (
            <div className="border-t">
              <div className="flex items-center gap-2 px-4 py-3">
                <History size={15} className="text-muted" />
                <h4 className="text-sm font-semibold text-fg">Recent deployments</h4>
              </div>
              <div className="max-h-56 divide-y overflow-y-auto border-t">
                {deployments.slice(0, 10).map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                    <span className="truncate tabular-nums text-muted">{new Date(d.created_at + "Z").toLocaleString()}</span>
                    <span className="text-fg-dim">{d.source}</span>
                    <code className="truncate font-mono text-fg" title={d.image_tag}>{d.image_tag?.split("@sha256:").pop()?.slice(0, 12) || "—"}</code>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
