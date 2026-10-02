import React, { useEffect, useMemo, useState } from "react";
import { Eye, GitBranch, Hammer, HardDrive, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { GitHubIcon } from "./brand-icons";
import { get } from "../api/client.ts";
import { runCliAction } from "../api/cli-actions.ts";
import { Badge, Btn, Card, CardHeader, CopyButton, EmptyState, Field, InlineNotice, StatusBadge, Table, confirm, showToast } from "./ui.tsx";
import { NeoSelect } from "./neo-select.tsx";
import { PermissionGate } from "./permission-gate.tsx";

type Server = { id: number; name: string; ipv4: string; status: string; apps?: Array<{ id: number }> };
type Worker = { id: number; name: string; status: string; worker_version: string; architecture: string; last_error: string; disk_free_bytes?: number; server: Server | null };
type Source = { id: number; repository: string; branch: string; webhook_secret_configured: boolean; last_status: string; last_error: string };
type GcRow = { server: { id: number; name: string }; images: unknown[]; reclaimable_ocd_image_bytes: number; reclaimable_foreign_image_bytes: number };

const stripAnsi = (value: string) => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
const bytes = (value: number) => value > 0 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : "0 MiB";

export function InfrastructureTools() {
  const [servers, setServers] = useState<Server[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [worker, setWorker] = useState({ server: "", name: "", removalToken: "" });
  const [workerBusy, setWorkerBusy] = useState(false);
  const [webhook, setWebhook] = useState<{ url: string; secret: string } | null>(null);
  const [gcServer, setGcServer] = useState("");
  const [gcRows, setGcRows] = useState<GcRow[] | null>(null);
  const [gcBusy, setGcBusy] = useState(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const load = async () => {
    const [serverRows, workerRows, sourceRows] = await Promise.all([get("/api/servers"), get("/api/runners"), get("/api/build-sources")]);
    setServers(serverRows || []); setWorkers(workerRows || []); setSources(sourceRows || []);
  };
  useEffect(() => { load().catch(() => {}); }, []);

  const eligible = useMemo(() => servers.filter((server) =>
    server.status === "ready" && !server.apps?.length && !workers.some((item) => item.server?.id === server.id)
  ), [servers, workers]);

  const installWorker = async () => {
    if (!worker.server) return;
    setWorkerBusy(true);
    try {
      await runCliAction("runners.install", { server: worker.server, name: worker.name || undefined, removalToken: worker.removalToken || undefined });
      setWorker({ server: "", name: "", removalToken: "" }); showToast("Build worker installed", "success"); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "Install failed", "error"); }
    finally { setWorkerBusy(false); }
  };

  const removeWorker = async (item: Worker) => {
    if (!await confirm("Remove Build Worker", `Remove ${item.name} and release ${item.server?.name || "its server"} for apps?`, true)) return;
    setWorkerBusy(true);
    try { await runCliAction("runners.remove", { runner: String(item.id) }, { confirmed: true }); showToast("Build worker removed", "success"); await load(); }
    catch (error) { showToast(error instanceof Error ? error.message : "Removal failed", "error"); }
    finally { setWorkerBusy(false); }
  };

  const rotateWebhook = async (source: Source) => {
    if (!await confirm("Rotate Webhook Secret", `Rotate the secret for ${source.repository}#${source.branch}? The previous secret stops working immediately.`, true)) return;
    try {
      const result = await runCliAction("runners.webhook-secret", { source: String(source.id) }, { confirmed: true });
      const output = stripAnsi(result.stdout);
      const url = output.match(/^Payload URL:\s*(.+)$/m)?.[1]?.trim();
      const secret = output.match(/^Secret \(shown once\):\s*(.+)$/m)?.[1]?.trim();
      if (!url || !secret) throw new Error("CLI did not return a webhook secret");
      setWebhook({ url, secret }); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "Rotation failed", "error"); }
  };

  const previewGc = async () => {
    setGcBusy(true);
    try { const rows = await get(`/api/gc${gcServer ? `?server=${encodeURIComponent(gcServer)}` : ""}`); setGcRows(rows); setPreviewKey(gcServer || "all"); }
    catch (error) { showToast(error instanceof Error ? error.message : "GC preview failed", "error"); }
    finally { setGcBusy(false); }
  };
  const executeGc = async () => {
    if (previewKey !== (gcServer || "all")) return showToast("Run a fresh preview first", "error");
    const total = (gcRows || []).reduce((sum, row) => sum + row.reclaimable_ocd_image_bytes + row.reclaimable_foreign_image_bytes, 0);
    if (!await confirm("Execute Disk Cleanup", `Reclaim the previewed safe assets (${bytes(total)})?`, true)) return;
    setGcBusy(true);
    try { await runCliAction("gc.execute", { server: gcServer || undefined }, { confirmed: true }); showToast("Disk cleanup complete", "success"); setPreviewKey(null); await previewGc(); }
    catch (error) { showToast(error instanceof Error ? error.message : "GC failed", "error"); }
    finally { setGcBusy(false); }
  };

  const workerGate = (children: React.ReactNode) => <PermissionGate permission="servers.manage">{children}</PermissionGate>;

  return <div className="space-y-6">
    <Card className="overflow-hidden">
      <CardHeader
        title="Build workers"
        icon={<Hammer size={15} />}
        description="Dedicated BuildKit capacity and GitHub push sources."
        actions={<Btn size="xs" onClick={load}><RefreshCw size={13} /> Refresh</Btn>}
      />
      {workers.length > 0 ? <div className="max-md:p-3"><Table headers={["Worker", "Server", "Status", "Version", "Disk", ""]}>{workers.map((item) => <tr key={item.id}>
        <td className="font-mono text-xs font-medium text-fg">{item.name}</td>
        <td className="font-mono text-xs text-fg-dim">{item.server?.name || "Missing"}</td>
        <td><StatusBadge status={item.status} />{item.last_error && <div className="mt-0.5 text-xs text-danger">{item.last_error}</div>}</td>
        <td className="font-mono text-xs text-fg-dim">{item.worker_version || "—"}<div className="text-muted">{item.architecture || "—"}</div></td>
        <td className="whitespace-nowrap tabular-nums text-fg-dim">{item.disk_free_bytes ? `${(item.disk_free_bytes / 1024 ** 3).toFixed(1)} GB` : "—"}</td>
        <td className="text-right">{workerGate(<Btn variant="ghost" title={`Remove ${item.name}`} disabled={workerBusy} onClick={() => removeWorker(item)}><Trash2 size={15} /></Btn>)}</td>
      </tr>)}</Table></div> : <EmptyState message="No build workers" icon={Hammer} description="Install one on an empty, ready server to offload image builds." className="py-10" />}
      {workerGate(<div className="border-t">
        <div className="px-4 pt-3 text-sm font-semibold text-fg">Install a worker</div>
        <div className="px-4 pb-1">
          <Field label="Dedicated server" divider><NeoSelect value={worker.server} onChange={(server) => setWorker((form) => ({ ...form, server }))} options={eligible.map((item) => ({ value: String(item.id), label: item.name }))} placeholder="Select empty server" /></Field>
          <Field label="Worker name" divider><input value={worker.name} onChange={(e) => setWorker((form) => ({ ...form, name: e.target.value }))} placeholder="ocd-build-1" className="font-mono" /></Field>
          <Field label="Legacy removal token" divider><input type="password" value={worker.removalToken} onChange={(e) => setWorker((form) => ({ ...form, removalToken: e.target.value }))} placeholder="Only for conversion" /></Field>
        </div>
        <div className="flex justify-end gap-2 border-t bg-subtle/40 px-4 py-3"><Btn variant="primary" loading={workerBusy} disabled={!worker.server} onClick={installWorker}><Hammer size={14} /> Install worker</Btn></div>
      </div>)}
    </Card>

    {(sources.length > 0 || webhook) && <Card className="overflow-hidden">
      <CardHeader title="Repository webhooks" icon={<GitHubIcon size={15} className="text-fg" />} description="GitHub push sources that trigger builds" />
      {webhook && <div className="border-b p-4"><InlineNotice tone="warning" title="Webhook secret — shown once">
        <div className="mt-1.5 space-y-1">
          <div className="flex min-w-0 items-center gap-2"><span className="w-12 shrink-0 text-xs text-muted">URL</span><code className="min-w-0 break-all font-mono text-xs text-fg">{webhook.url}</code><CopyButton text={webhook.url} /></div>
          <div className="flex min-w-0 items-center gap-2"><span className="w-12 shrink-0 text-xs text-muted">Secret</span><code className="min-w-0 break-all font-mono text-xs text-fg">{webhook.secret}</code><CopyButton text={webhook.secret} /></div>
        </div>
      </InlineNotice></div>}
      {sources.length > 0 && <div className="max-md:p-3"><Table headers={["Repository", "Branch", "Status", "Webhook", ""]}>{sources.map((source) => <tr key={source.id}>
        <td className="break-all font-mono text-xs font-medium text-fg">{source.repository}</td>
        <td className="font-mono text-xs text-fg-dim">{source.branch}</td>
        <td><StatusBadge status={source.last_status || "idle"} />{source.last_error && <div className="mt-0.5 text-xs text-danger">{source.last_error}</div>}</td>
        <td>{source.webhook_secret_configured ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Missing</Badge>}</td>
        <td className="text-right">{workerGate(<Btn size="xs" onClick={() => rotateWebhook(source)}><KeyRound size={13} /> Rotate</Btn>)}</td>
      </tr>)}</Table></div>}
    </Card>}

    <Card className="overflow-hidden">
      <CardHeader title="Disk cleanup" icon={<HardDrive size={15} />} description="Preview is mandatory; runtime and rollback images remain protected." />
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <span className="text-sm text-muted">Server</span>
        <div className="w-full min-w-0 sm:w-56"><NeoSelect value={gcServer} onChange={(value) => { setGcServer(value); setPreviewKey(null); }} options={servers.map((item) => ({ value: String(item.id), label: item.name }))} placeholder="All servers" /></div>
        <div className="flex gap-2 sm:ml-auto">
          <Btn loading={gcBusy} onClick={previewGc}><Eye size={14} /> Preview</Btn>
          {workerGate(<Btn variant="danger" loading={gcBusy} disabled={!gcRows || previewKey !== (gcServer || "all")} onClick={executeGc}>Execute preview</Btn>)}
        </div>
      </div>
      {gcRows && <div className="border-t max-md:p-3"><Table headers={["Server", "Images", "OCD reclaimable", "Foreign reclaimable"]}>{gcRows.map((row) => <tr key={row.server.id}>
        <td className="font-mono text-xs font-medium text-fg">{row.server.name}</td>
        <td className="tabular-nums text-fg-dim">{row.images.length}</td>
        <td className="tabular-nums text-fg-dim">{bytes(row.reclaimable_ocd_image_bytes)}</td>
        <td className="tabular-nums text-fg-dim">{bytes(row.reclaimable_foreign_image_bytes)}</td>
      </tr>)}</Table></div>}
    </Card>
  </div>;
}
