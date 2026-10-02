import { useState, useEffect } from "react";
import { get, post, put, del } from "../../api/client.ts";
import { Card, CardHeader, Btn, Badge, Table, Field, InfoTip, InlineNotice, EmptyState, StatusBadge, CopyButton, showToast, confirm } from "../../components/ui.tsx";
import { Hammer, Key, Package, GitBranch, Webhook, Trash2 } from "lucide-react";
import { GitHubIcon } from "../../components/brand-icons";

type BuildWorker = {
  id: number; name: string; status: string;
  worker_version: string; architecture: string; last_error: string;
  disk_free_bytes?: number; server: { id: number; name: string } | null;
};

type BuildSource = {
  id: number; repository: string; branch: string;
  webhook_secret_configured: boolean; last_status: string; last_error: string;
};

type Connection = { connected: boolean; scope?: string; host?: string };

export function BuildSettings() {
  const [workers, setWorkers] = useState<BuildWorker[]>([]);
  const [sources, setSources] = useState<BuildSource[]>([]);
  const [registry, setRegistry] = useState<Connection>({ connected: false });
  const [source, setSource] = useState<Connection>({ connected: false });
  const [shownWebhook, setShownWebhook] = useState<{ url: string; secret: string } | null>(null);

  const refresh = () => Promise.all([
    get("/api/runners").then((data) => setWorkers(data || [])),
    get("/api/build-sources").then((data) => setSources(data || [])),
    get("/api/connections").then((c) => {
      setRegistry(c.registry ?? { connected: false });
      setSource(c.source ?? { connected: false });
    }),
  ]).catch(() => {});

  useEffect(() => { refresh(); }, []);

  const rotateWebhook = async (s: BuildSource) => {
    if (!await confirm("Rotate webhook secret", `Rotate the GitHub webhook secret for ${s.repository}#${s.branch}? The previous secret stops working immediately.`, true)) return;
    try {
      const result = await post(`/api/build-sources/${s.id}/webhook-secret`, {});
      setShownWebhook({ url: result.webhook_url, secret: result.secret });
      await refresh();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          icon={<Key size={15} />}
          title={<span className="inline-flex items-center gap-1">Build connections <InfoTip>Credentials are encrypted and sent only to the configured Git host or registry scope.</InfoTip></span>}
          description="Registry and private source credentials used by build workers"
        />
        <ConnectionRow
          kind="registry"
          icon={<Package size={15} />}
          title="OCI registry"
          tip="Works with GHCR, GitLab, Docker Hub, Quay, Harbor, and self-hosted OCI registries."
          idle="Push and pull built images"
          detail={registry.scope}
          connected={registry.connected}
          offLabel="Not connected"
          fields={[
            { key: "scope", label: "Registry scope", placeholder: "registry.example.com/team", mono: true, hint: "The credential boundary, such as registry.example.com/team." },
            { key: "username", label: "Username", placeholder: "acme" },
            { key: "token", label: "Password / token", placeholder: "Registry password or token", secret: true },
          ]}
          disconnectText="Remove the stored OCI registry credential? Existing deployed images keep running, but new builds and pulls may fail."
          onChange={refresh}
        />
        <ConnectionRow
          kind="source"
          icon={<GitBranch size={15} />}
          title="Private Git repositories"
          tip="Public repositories work without credentials. Configure this only for private repositories on an HTTPS Git host."
          idle="Check out private repositories over HTTPS"
          detail={source.host}
          connected={source.connected}
          offLabel="Public only"
          fields={[
            { key: "host", label: "Git host", placeholder: "git.example.com", mono: true },
            { key: "username", label: "Git username", placeholder: "git-user", hint: "Host-specific. GitHub commonly uses x-access-token." },
            { key: "token", label: "Read-only token", placeholder: "Token for private checkout", secret: true },
          ]}
          disconnectText="Remove the stored private Git checkout credential? Public repositories remain available."
          onChange={refresh}
        />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          icon={<Hammer size={15} />}
          title={<span className="inline-flex items-center gap-1">Build workers <InfoTip>Workers check out an exact commit, build and push its image, then deploy the immutable digest.</InfoTip></span>}
          description="Install or remove workers with ocd runners install / ocd runners remove"
        />
        {workers.length === 0 ? <EmptyState icon={Hammer} message="No build workers" description="Run ocd runners install on an empty server to build images from source." /> : (
          <Table headers={["Worker", "Server", "Status", "Version", "Disk"]}>
            {workers.map((w) => (
              <tr key={w.id}>
                <td className="font-mono text-xs text-fg">{w.name}</td>
                <td className="font-mono text-xs text-fg-dim">{w.server?.name || "Missing"}</td>
                <td><StatusBadge status={w.status} />{w.last_error && <div className="mt-1 max-w-xs break-words text-xs text-danger">{w.last_error}</div>}</td>
                <td className="font-mono text-xs text-fg-dim">{w.worker_version || "—"}<div className="text-muted">{w.architecture || "—"}</div></td>
                <td className="whitespace-nowrap font-mono text-xs tabular-nums text-fg-dim">{w.disk_free_bytes ? `${(w.disk_free_bytes / 1024 ** 3).toFixed(1)} GB` : "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader icon={<GitHubIcon size={15} className="text-fg" />} title="GitHub push webhooks" description={`${sources.length} source${sources.length === 1 ? "" : "s"}`} />
        {sources.length === 0 ? <EmptyState icon={Webhook} message="No build sources" description="Sources appear after the first ocd deploy of an app built from a repository." /> : (
          <Table headers={["Source", "Branch", "Status", "Webhook", ""]}>
            {sources.map((s) => <tr key={s.id}>
              <td className="break-all font-mono text-xs text-fg">{s.repository}</td>
              <td className="font-mono text-xs text-fg-dim">{s.branch}</td>
              <td><StatusBadge status={s.last_status || "idle"} />{s.last_error && <div className="mt-1 max-w-xs break-words text-xs text-danger">{s.last_error}</div>}</td>
              <td>{s.webhook_secret_configured ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Missing</Badge>}</td>
              <td className="text-right"><Btn size="xs" onClick={() => rotateWebhook(s)}><Key size={12} /> Rotate</Btn></td>
            </tr>)}
          </Table>
        )}
        {shownWebhook && <div className="border-t p-4">
          <InlineNotice tone="warning" title="Webhook secret — shown once">
            <div className="mt-2 space-y-2">
              <div className="flex min-w-0 items-center gap-2"><span className="w-14 shrink-0 text-xs text-muted">URL</span><code className="min-w-0 flex-1 select-all break-all rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">{shownWebhook.url}</code><CopyButton text={shownWebhook.url} /></div>
              <div className="flex min-w-0 items-center gap-2"><span className="w-14 shrink-0 text-xs text-muted">Secret</span><code className="min-w-0 flex-1 select-all break-all rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">{shownWebhook.secret}</code><CopyButton text={shownWebhook.secret} /></div>
              <div className="flex items-center gap-1 text-xs text-muted">Webhook setup <InfoTip>Use content type application/json and subscribe to push events only.</InfoTip></div>
            </div>
          </InlineNotice>
        </div>}
      </Card>
    </>
  );
}

type ConnectionField = { key: string; label: string; placeholder: string; hint?: string; mono?: boolean; secret?: boolean };

function ConnectionRow({ kind, icon, title, tip, idle, detail, connected, offLabel, fields, disconnectText, onChange }: {
  kind: "registry" | "source";
  icon: React.ReactNode;
  title: string;
  tip: string;
  idle: string;
  detail?: string;
  connected: boolean;
  offLabel: string;
  fields: ConnectionField[];
  disconnectText: string;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const path = `/api/connections/${kind}`;

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      setEditing(false);
      setValues({});
      onChange();
      showToast(message, "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-sm font-medium text-fg">{title} <InfoTip>{tip}</InfoTip></div>
          {connected && detail ? <div className="break-all font-mono text-xs text-muted">{detail}</div> : <div className="text-xs text-muted">{idle}</div>}
        </div>
        <Badge tone={connected ? "success" : kind === "registry" ? "warning" : "neutral"}>{connected ? "Connected" : offLabel}</Badge>
        <Btn size="xs" onClick={() => setEditing((open) => !open)}>{editing ? "Close" : connected ? "Edit" : "Configure"}</Btn>
      </div>
      {editing && <div className="animate-slide-up border-t bg-canvas/40">
        <div className="px-4">
          {fields.map((field) => (
            <Field key={field.key} divider label={field.label} align={field.hint ? "start" : undefined} hint={field.hint}>
              <input
                type={field.secret ? "password" : "text"}
                className={field.mono ? "font-mono" : undefined}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                placeholder={field.placeholder}
              />
            </Field>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-subtle/40 px-4 py-3">
          <div>{connected && <Btn variant="ghost" disabled={busy} onClick={async () => {
            if (await confirm(`Disconnect ${title}`, disconnectText, true)) await run(() => del(path), "Disconnected");
          }}><Trash2 size={14} /> Disconnect</Btn>}</div>
          <Btn variant="primary" loading={busy} disabled={fields.some((f) => !values[f.key])} onClick={() => run(() => put(path, values), "Connected")}>
            <Key size={14} /> {connected ? "Update connection" : "Connect"}
          </Btn>
        </div>
      </div>}
    </div>
  );
}
