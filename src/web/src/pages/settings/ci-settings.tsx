import { useEffect, useState } from "react";
import { get, post, put, del } from "../../api/client.ts";
import { Card, CardHeader, Btn, Table, StatusBadge, InlineNotice, EmptyState, showToast, confirm } from "../../components/ui.tsx";
import { GitBranch, Key } from "lucide-react";

type Runner = { id: number; name: string; repository: string; status: string; shared_builds: number; draining: number; runner_version: string; last_error: string; server: { name: string } | null; actions_url: string };
export function CiSettings() {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [connection, setConnection] = useState<{ connected: boolean; app_id?: string; auth_type?: string; account_login?: string }>({ connected: false });
  const [editing, setEditing] = useState(false);
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    try {
      const [rows, config] = await Promise.all([get("/api/ci/runners"), get("/api/ci/connection")]);
      setRunners(rows); setConnection(config); setError("");
    } catch (err: any) { setError(err.message); }
  };
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 15000); return () => clearInterval(timer); }, []);
  const action = async (runner: Runner, action: string) => {
    if (action === "remove" && !await confirm("Remove CI runner", `Remove ${runner.name}? Its server is retained. Drain it and let its current job finish first.`, true)) return;
    setBusy(true);
    try {
      const result = action === "remove" ? await del(`/api/ci/runners/${runner.id}`) : await post(`/api/ci/runners/${runner.id}`, { action });
      showToast(`CI operation #${result.op_id} queued`, "success");
      await refresh();
    } catch (err: any) { showToast(err.message, "error"); } finally { setBusy(false); }
  };
  return <Card className="overflow-hidden">
    <CardHeader icon={<GitBranch size={15} />} title="GitHub Actions CI" description="Dedicated or shared build servers, one workload at a time. Install with ocd ci install." />
    {error && <div className="p-4"><InlineNotice tone="warning">{error}</InlineNotice></div>}
    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
      <div className="text-sm text-fg">{connection.connected ? connection.auth_type === "token" ? `GitHub account ${connection.account_login} connected` : `GitHub App ${connection.app_id} connected` : "Connect a GitHub App to manage CI runners"}</div>
      <Btn size="xs" onClick={() => setEditing(!editing)}><Key size={12} />{editing ? "Close" : "Configure"}</Btn>
    </div>
    {editing && <div className="space-y-3 border-b p-4">
      <p className="text-xs text-muted">Install the App on selected private repositories with Administration write, Actions read, and Checks read permissions.</p>
      <label className="block text-xs text-muted">App ID<input value={appId} onChange={e => setAppId(e.target.value)} inputMode="numeric" /></label>
      <label className="block text-xs text-muted">Installation ID<input value={installationId} onChange={e => setInstallationId(e.target.value)} inputMode="numeric" /></label>
      <label className="block text-xs text-muted">RSA private key (PEM)<textarea className="w-full font-mono text-xs" rows={4} value={privateKey} onChange={e => setPrivateKey(e.target.value)} autoComplete="off" /></label>
      <Btn variant="primary" disabled={busy || !appId || !installationId || !privateKey} onClick={async () => {
        setBusy(true);
        try {
          await put("/api/ci/connection", { app_id: appId, installation_id: installationId, private_key: privateKey });
          setPrivateKey(""); setEditing(false); await refresh(); showToast("GitHub App connected", "success");
        } catch (err: any) { showToast(err.message, "error"); } finally { setBusy(false); }
      }}>Connect</Btn>
    </div>}
    {!runners.length ? <EmptyState icon={GitBranch} message="No CI runners" description="Run ocd ci install --server=ci-1 --repository=owner/repo on an empty server." /> : <Table headers={["Runner", "Repository", "Status", "Version", ""]}>
      {runners.map(runner => <tr key={runner.id}>
        <td className="font-mono text-xs text-fg">{runner.name}<div className="text-muted">{runner.server?.name || "Missing server"}{runner.shared_builds ? " · shared with builds" : ""}</div></td>
        <td className="text-xs"><a href={runner.actions_url} target="_blank" rel="noreferrer" className="text-accent">{runner.repository}</a></td>
        <td><StatusBadge status={runner.status} />{!!runner.draining && <div className="text-xs text-muted">Draining</div>}{runner.last_error && <div className="max-w-xs break-words text-xs text-danger">{runner.last_error}</div>}</td>
        <td className="font-mono text-xs text-muted">{runner.runner_version || "—"}</td>
        <td><div className="flex flex-wrap justify-end gap-2">
          <Btn size="xs" disabled={busy} onClick={() => action(runner, runner.draining ? "resume" : "drain")}>{runner.draining ? "Resume" : "Drain"}</Btn>
          {!!runner.last_error && <Btn size="xs" disabled={busy} onClick={() => action(runner, "retry")}>Retry</Btn>}
          {runner.status === "drained" && <Btn size="xs" disabled={busy} onClick={() => action(runner, "remove")}>Remove</Btn>}
        </div></td>
      </tr>)}
    </Table>}
  </Card>;
}
