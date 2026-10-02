import { PanelProtection } from "./panel-protection.tsx";
import { AdminNtfySettings } from "../../components/ntfy-settings.tsx";
import { useState, useEffect } from "react";
import { get, post, del, put } from "../../api/client.ts";
import { Card, CardHeader, Btn, Badge, Table, Field, DataRow, InfoTip, InlineNotice, EmptyState, StatusBadge, CopyButton, humanize, showToast, confirm, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { useHashParam } from "../../hooks/use-hash-param.ts";
import { NeoSelect } from "../../components/neo-select.tsx";
import { HetznerIcon, GitHubIcon, gitHostIcon } from "../../components/brand-icons";
import { ArrowRight, Users, Plus, Trash2, Shield, ShieldCheck, Key, ShieldAlert, Save, RefreshCw, Server as ServerIcon, Settings, Copy, Check, Hammer, Cloud, Rocket, Package, GitBranch, History, ChevronDown, ChevronRight, Fingerprint } from "lucide-react";
import type { PanelApp, DeploymentRecord } from "../../types.ts";
import { DnsInstructionView } from "../../components/dns-instruction.tsx";
import { runCliAction } from "../../api/cli-actions.ts";

const stripAnsi = (value: string) => value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");

function GitHubOAuthSettings({ form, setS }: {
  form: { github_oauth_client_id: string; github_oauth_client_secret: string };
  setS: (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const [copied, setCopied] = useState(false);
  const callbackUrl = `${window.location.origin}/api/auth/github/callback`;

  const copyUrl = () => {
    navigator.clipboard.writeText(callbackUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <Field divider label="Callback URL" align="start" hint="Paste this as the Authorization callback URL in your GitHub OAuth app.">
        <div className="flex h-8 items-center gap-2 rounded-md border bg-subtle/60 pl-2.5 pr-1">
          <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-fg">{callbackUrl}</code>
          <button type="button" onClick={copyUrl} aria-label="Copy callback URL" className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition-colors hover:bg-subtle hover:text-fg">
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
        </div>
      </Field>
      <Field divider label="Client ID">
        <input type="text" className="font-mono" value={form.github_oauth_client_id} onChange={setS("github_oauth_client_id")} placeholder="Ov23li..." />
      </Field>
      <Field divider label="Client secret">
        <input type="password" value={form.github_oauth_client_secret} onChange={setS("github_oauth_client_secret")} placeholder="Client secret" />
      </Field>
    </>
  );
}

const initials = (name: string) => {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
};

const FORM_FOOTER = "flex flex-wrap justify-end gap-2 border-t bg-subtle/40 px-4 py-3";

type User = {
  id: string; username: string; isAdmin: boolean;
  webauthnEnabled: boolean; permissions: string[]; createdAt: string;
};

type RunnerServer = {
  id: number; name: string; ipv4: string; status: string;
  apps?: Array<{ id: number; name: string }>;
};

type BuildWorker = {
  id: number; name: string; status: string;
  worker_version: string; architecture: string; last_error: string;
  disk_free_bytes?: number; server: RunnerServer | null;
};

type BuildSource = {
  id: number; repository: string; branch: string; webhook_url: string;
  webhook_enabled: number; webhook_secret_configured: boolean;
  last_commit: string; last_status: string; last_error: string;
};

type Readiness = {
  ready: boolean;
  worker: { status: string; online: number; total: number };
  registry: { status: string; configured: boolean; scope: string };
  source: { status: string; configured: boolean; host: string };
  actions: Array<{ command: string; label: string }>;
};

type AdminSection = "overview" | "hetzner" | "infrastructure" | "build" | "panel" | "users";
type LatestPanelRelease = { commit: string; image: string; currentImage: string; upToDate: boolean };

const ADMIN_SECTIONS: Array<{ key: AdminSection; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "hetzner", label: "Hetzner" },
  { key: "infrastructure", label: "Infrastructure" },
  { key: "build", label: "Build & Registry" },
  { key: "panel", label: "Panel" },
  { key: "users", label: "Users & Security" },
];

export function UsersPage() {
  const [section, setSection] = useHashParam("section", ADMIN_SECTIONS.map((item) => item.key), "overview");
  // --- Users ---
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [require2fa, setRequire2fa] = useState(true);
  const [savingRequire2fa, setSavingRequire2fa] = useState(false);

  // --- Instance Settings ---
  const [settingsForm, setSettingsForm] = useState({
    hetzner_api_token: "",
    hetzner_s3_access_key: "", hetzner_s3_secret_key: "", hetzner_s3_region: "fsn1",
    github_oauth_client_id: "", github_oauth_client_secret: "",
    default_domain_suffix: "",
    oci_artifact_ref: "", oci_registry_username: "", oci_registry_password: "",
    github_build_host: "", github_build_username: "", github_build_token: "",
  });
  const [hetznerStatus, setHetznerStatus] = useState({
    configured: false, s3Configured: false, s3Regions: ["fsn1", "nbg1", "hel1"],
  });
  const [hetznerEditing, setHetznerEditing] = useState(false);
  const [registryConnected, setRegistryConnected] = useState(false);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<"registry" | "source" | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [infrastructureEditing, setInfrastructureEditing] = useState(false);
  const [registryEditing, setRegistryEditing] = useState(false);
  const [sourceEditing, setSourceEditing] = useState(false);
  const [oauthEditing, setOauthEditing] = useState(false);

  // --- Panel ---
  const [panel, setPanel] = useState<PanelApp | null>(null);
  const [panelServer, setPanelServer] = useState<{ id: number; name: string; ipv4: string } | null>(null);
  const [panelDeployments, setPanelDeployments] = useState<DeploymentRecord[]>([]);
  const [panelBusy, setPanelBusy] = useState(false);
  const [panelImage, setPanelImage] = useState("");
  const [panelReleaseOpen, setPanelReleaseOpen] = useState(false);
  const [latestPanelRelease, setLatestPanelRelease] = useState<LatestPanelRelease | null>(null);
  const [latestPanelError, setLatestPanelError] = useState("");
  const [latestPanelLoading, setLatestPanelLoading] = useState(false);

  // --- OCD BuildKit workers and repository webhooks ---
  const [runners, setRunners] = useState<BuildWorker[]>([]);
  const [buildSources, setBuildSources] = useState<BuildSource[]>([]);
  const [runnerServers, setRunnerServers] = useState<RunnerServer[]>([]);
  const [runnerBusy, setRunnerBusy] = useState(false);
  const [addingWorker, setAddingWorker] = useState(false);
  const [workerAdvanced, setWorkerAdvanced] = useState(false);
  const [runnerForm, setRunnerForm] = useState({
    server_id: "", name: "", removal_token: "",
  });
  const [shownWebhook, setShownWebhook] = useState<{ url: string; secret: string } | null>(null);
  const availableRunnerServers = runnerServers.filter((server) =>
    server.status === "ready" &&
    !server.apps?.length &&
    server.id !== panelServer?.id &&
    !runners.some((runner) => runner.server?.id === server.id),
  );

  const refreshRunners = () => Promise.all([
    get("/api/runners").then((data) => setRunners(data || [])),
    get("/api/build-sources").then((data) => setBuildSources(data || [])),
    get("/api/servers").then((data) => {
      const servers = (data || []) as RunnerServer[];
      setRunnerServers(servers);
    }),
  ]).catch(() => {});
  const refreshReadiness = () => get("/api/readiness").then(setReadiness).catch(() => {});
  const applyHetznerSettings = (s: any) => {
    setHetznerStatus({
      configured: s.hetzner_configured === true,
      s3Configured: s.hetzner_s3_configured === true,
      s3Regions: Array.isArray(s.hetzner_s3_regions) && s.hetzner_s3_regions.length ? s.hetzner_s3_regions : ["fsn1", "nbg1", "hel1"],
    });
    setSettingsForm((current) => ({ ...current,
      hetzner_api_token: s.hetzner_api_token ?? "",
      hetzner_s3_access_key: s.hetzner_s3_access_key ?? "",
      hetzner_s3_secret_key: s.hetzner_s3_secret_key ?? "",
      hetzner_s3_region: s.hetzner_s3_region || "fsn1",
    }));
  };

  const loadUsers = async () => {
    try {
      const res = await get("/api/admin/users");
      setUsers(res.users);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const refreshPanel = () => {
    get("/api/admin/panel")
      .then((data) => {
        setPanel(data.panel ? { ...data.panel, dns_instruction: data.dns_instruction } : null);
        setPanelServer(data.server);
      })
      .catch(() => {});
    get("/api/admin/panel/deployments")
      .then((data) => {
        const deployments = (data || []) as DeploymentRecord[];
        setPanelDeployments(deployments);
        const currentImage = deployments.find((deployment) => deployment.status === "deployed")?.image_tag;
        if (currentImage) setPanelImage(currentImage);
      })
      .catch(() => {});
  };

  const refreshLatestPanelRelease = async () => {
    setLatestPanelLoading(true);
    try {
      setLatestPanelRelease(await get("/api/admin/panel/latest-release"));
      setLatestPanelError("");
    } catch (error) {
      setLatestPanelRelease(null);
      setLatestPanelError(error instanceof Error ? error.message : "Could not find the latest main image");
    } finally {
      setLatestPanelLoading(false);
    }
  };

  useEffect(() => {
    if (section === "panel" && panel) void refreshLatestPanelRelease();
  }, [section, !!panel]);

  useEffect(() => {
    loadUsers();
    get("/api/admin/settings")
      .then((s) => {
        setRequire2fa(s.require_2fa !== false);
        setSettingsForm({
          hetzner_api_token: "", hetzner_s3_access_key: "", hetzner_s3_secret_key: "", hetzner_s3_region: "fsn1",
          github_oauth_client_id: s.github_oauth_client_id ?? "",
          github_oauth_client_secret: s.github_oauth_client_secret ?? "",
          default_domain_suffix: s.default_domain_suffix ?? "",
          oci_artifact_ref: s.oci_artifact_ref ?? "",
          oci_registry_username: s.oci_registry_username ?? "",
          oci_registry_password: "",
          github_build_username: s.github_build_username ?? "",
          github_build_host: s.github_build_host ?? "",
          github_build_token: "",
        });
        applyHetznerSettings(s);
      })
      .catch(() => {})
      .finally(() => setSettingsLoading(false));
    get("/api/admin/connections").then((connections) => {
      setRegistryConnected(connections.registry?.connected === true);
      setSourceConnected(connections.source?.connected === true);
    }).catch(() => {});
    refreshPanel();
    refreshRunners();
    refreshReadiness();
  }, []);

  useEffect(() => {
    if (!runners.some((runner) => ["installing", "removing"].includes(runner.status))) return;
    const timer = window.setInterval(refreshRunners, 5000);
    return () => window.clearInterval(timer);
  }, [runners]);

  const refreshInfrastructure = async () => {
    const settings = await get("/api/admin/settings");
    applyHetznerSettings(settings);
  };

  const setS = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setSettingsForm((f) => ({ ...f, [k]: e.target.value }));

  const toggleRequire2fa = async (next: boolean) => {
    setSavingRequire2fa(true);
    setRequire2fa(next);
    try {
      await put("/api/admin/settings", { require_2fa: next });
      showToast(next ? "2FA now required for new users" : "2FA no longer required", "success");
    } catch (err: any) {
      setRequire2fa(!next);
      showToast(err.message, "error");
    } finally {
      setSavingRequire2fa(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) return showToast("Username and password required", "error");
    setCreating(true);
    try {
      await post("/api/admin/users", form);
      showToast("User created", "success");
      setShowCreate(false);
      setForm({ username: "", password: "" });
      loadUsers();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (user: User) => {
    if (!await confirm("Delete user", `Delete user "${user.username}"? This cannot be undone.`, true)) return;
    try {
      await del(`/api/admin/users/${user.id}`);
      showToast("User deleted", "success");
      loadUsers();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const {
        oci_artifact_ref: _registryScope,
        oci_registry_username: _registryUsername,
        oci_registry_password: _registryToken,
        github_build_host: _sourceHost,
        github_build_username: _sourceUsername,
        github_build_token: _sourceToken,
        hetzner_api_token: _hetznerToken,
        hetzner_s3_access_key: _s3AccessKey,
        hetzner_s3_secret_key: _s3SecretKey,
        hetzner_s3_region: _s3Region,
        ...instanceSettings
      } = settingsForm;
      await put("/api/admin/settings", instanceSettings);
      await refreshReadiness();
      showToast("Settings saved", "success");
      setInfrastructureEditing(false);
      setOauthEditing(false);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const saveHetzner = async () => {
    setSaving(true);
    try {
      await put("/api/admin/settings", {
        hetzner_api_token: settingsForm.hetzner_api_token,
        hetzner_s3_access_key: settingsForm.hetzner_s3_access_key,
        hetzner_s3_secret_key: settingsForm.hetzner_s3_secret_key,
        hetzner_s3_region: settingsForm.hetzner_s3_region,
      });
      await refreshInfrastructure();
      await refreshReadiness();
      showToast("Hetzner settings saved", "success");
      setHetznerEditing(false);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const connectRegistry = async () => {
    setConnectionBusy("registry");
    try {
      await runCliAction("registry.login", {
        scope: settingsForm.oci_artifact_ref,
        username: settingsForm.oci_registry_username,
        token: settingsForm.oci_registry_password,
      });
      setRegistryConnected(true);
      setRegistryEditing(false);
      refreshReadiness();
      showToast("Registry connected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const disconnectRegistry = async () => {
    if (!await confirm("Disconnect registry", "Remove the stored OCI registry credential? Existing deployed images keep running, but new builds and pulls may fail.", true)) return;
    setConnectionBusy("registry");
    try {
      await runCliAction("registry.logout", {}, { confirmed: true });
      setRegistryConnected(false);
      refreshReadiness();
      setSettingsForm((current) => ({ ...current, oci_artifact_ref: "", oci_registry_username: "", oci_registry_password: "" }));
      showToast("Registry disconnected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const connectSource = async () => {
    setConnectionBusy("source");
    try {
      await runCliAction("source.login", {
        host: settingsForm.github_build_host,
        username: settingsForm.github_build_username,
        token: settingsForm.github_build_token,
      });
      setSourceConnected(true);
      setSourceEditing(false);
      refreshReadiness();
      showToast("Private source access connected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const disconnectSource = async () => {
    if (!await confirm("Disconnect source", "Remove the stored private Git checkout credential? Public repositories remain available.", true)) return;
    setConnectionBusy("source");
    try {
      await runCliAction("source.logout", {}, { confirmed: true });
      setSourceConnected(false);
      refreshReadiness();
      setSettingsForm((current) => ({ ...current, github_build_host: "", github_build_username: "", github_build_token: "" }));
      showToast("Source access disconnected", "success");
    } catch (err: any) { showToast(err.message, "error"); }
    finally { setConnectionBusy(null); }
  };

  const redeployPanelNow = async () => {
    const image = panelImage.trim();
    if (!/@sha256:[0-9a-f]{64}$/i.test(image)) {
      showToast("Enter an immutable image reference ending in @sha256:<64 hex characters>", "error");
      return;
    }
    if (!await confirm(
      "Redeploy panel image",
      `Redeploy ${image} to the panel? The panel will briefly become unavailable and you will need to reload this page once it comes back.`,
      true,
    )) return;
    setPanelBusy(true);
    try {
      const result = await post("/api/admin/panel/redeploy", { image });
      if (result?.ok) {
        showToast("Panel redeploy dispatched", "success");
        setPanelReleaseOpen(false);
        setTimeout(refreshPanel, 2000);
      } else {
        showToast(result?.error || "Failed to dispatch redeploy", "error");
      }
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setPanelBusy(false);
    }
  };

  const redeployLatestPanel = async () => {
    if (!latestPanelRelease) return;
    const { commit, image, upToDate } = latestPanelRelease;
    if (!await confirm(
      upToDate ? "Redeploy current panel" : "Redeploy latest main",
      `${upToDate ? "Restart the panel on" : "Redeploy the panel from"} main commit ${commit.slice(0, 12)} using ${image}? The panel will briefly become unavailable.`,
      true,
    )) return;
    setPanelBusy(true);
    try {
      const result = await post("/api/admin/panel/latest-release", { commit, image });
      if (!result?.ok) throw new Error(result?.error || "Could not dispatch panel release");
      showToast("Panel redeploy dispatched; wait for it to return, then refresh", "success");
      setTimeout(refreshPanel, 5000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not release panel", "error");
      void refreshLatestPanelRelease();
    } finally {
      setPanelBusy(false);
    }
  };

  const installRunner = async () => {
    if (!runnerForm.server_id) {
      return showToast("Select a dedicated server", "error");
    }
    setRunnerBusy(true);
    try {
      await runCliAction("runners.install", {
        server: runnerForm.server_id,
        name: runnerForm.name || undefined,
        removalToken: runnerForm.removal_token || undefined,
      });
      setRunnerForm((current) => ({ ...current, removal_token: "" }));
      setAddingWorker(false);
      setWorkerAdvanced(false);
      showToast("Build worker installed", "success");
      await refreshRunners();
      await refreshReadiness();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setRunnerBusy(false);
    }
  };

  const removeRunner = async (runner: BuildWorker) => {
    if (!await confirm("Remove build worker", `Remove ${runner.name} and release ${runner.server?.name || "its server"} for apps?`, true)) return;
    setRunnerBusy(true);
    try {
      await runCliAction("runners.remove", { runner: String(runner.id) }, { confirmed: true });
      showToast("Build worker removed", "success");
      await refreshRunners();
      await refreshReadiness();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setRunnerBusy(false);
    }
  };

  const rotateWebhook = async (source: BuildSource) => {
    if (!await confirm("Rotate webhook secret", `Rotate the GitHub webhook secret for ${source.repository}#${source.branch}? The previous secret stops working immediately.`, true)) return;
    try {
      const result = await runCliAction("runners.webhook-secret", { source: String(source.id) }, { confirmed: true });
      const output = stripAnsi(result.stdout);
      const url = output.match(/^Payload URL:\s*(.+)$/m)?.[1]?.trim();
      const secret = output.match(/^Secret \(shown once\):\s*(.+)$/m)?.[1]?.trim();
      if (!url || !secret) throw new Error("CLI did not return the rotated webhook secret");
      setShownWebhook({ url, secret });
      await refreshRunners();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  if (loading || settingsLoading) return <PageState title="Loading administration" />;

  const deployedPanelImage = panel ? panelDeployments.find((deployment) => deployment.status === "deployed")?.image_tag || panel.image_ref || "—" : "—";

  return (
    <PageShell>
      <PageHeader title="Admin" description="Hetzner, app domain, build delivery, panel settings, and user access." />

      <TabBar tabs={ADMIN_SECTIONS} active={section} onChange={setSection} />

      {section === "overview" && readiness && <Card className="overflow-hidden">
        <CardHeader
          icon={<Rocket size={15} />}
          title={<span className="inline-flex items-center gap-1">Deploy readiness <InfoTip>The first deploy can create missing build capacity automatically. Review required actions below before deploying.</InfoTip></span>}
          actions={<Btn size="xs" variant="ghost" onClick={refreshReadiness}><RefreshCw size={12} /> Recheck</Btn>}
        />
        <div className="cells grid grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Hetzner", value: hetznerStatus.configured ? "Connected" : "Not configured", ok: hetznerStatus.configured, Logo: HetznerIcon },
            { label: "Git source", value: readiness.source.configured ? readiness.source.host : "Not connected", ok: readiness.source.configured, Logo: gitHostIcon(readiness.source.host) },
            { label: "Build worker", value: `${readiness.worker.online} online`, ok: readiness.worker.online > 0 },
            { label: "Registry", value: readiness.registry.configured ? readiness.registry.scope : "Not connected", ok: readiness.registry.configured },
          ].map(({ label, value, ok, Logo }) => <div key={String(label)} className="min-w-0 bg-surface px-4 py-3.5">
            <div className="flex items-center gap-1.5 text-xs text-muted">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-success" : "bg-warning"}`} />
              {label}
              {Logo && <Logo size={12} className="ml-auto" />}
            </div>
            <div className="mt-1 break-all text-sm font-medium text-fg">{value}</div>
          </div>)}
        </div>
        {readiness.actions.length > 0 && <div className="border-t p-4">
          <InlineNotice tone="warning" title="Next actions">
            <ul className="mt-1 space-y-1.5">
              {readiness.actions.map((action) => <li key={action.command} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{action.label}</span>
                <code className="select-all rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">{action.command}</code>
              </li>)}
            </ul>
          </InlineNotice>
        </div>}
      </Card>}

      {section === "overview" && (
        <div className="frame bg-surface"><div className="cells grid sm:grid-cols-2 lg:grid-cols-3">
          {[
            { key: "hetzner" as const, label: "Hetzner", value: hetznerStatus.configured ? "Connected" : "Not set", unit: hetznerStatus.s3Configured ? "Object Storage connected" : "Object Storage not configured", icon: HetznerIcon },
            { key: "infrastructure" as const, label: "Infrastructure", value: settingsForm.default_domain_suffix || "—", unit: "App domain", icon: ServerIcon },
            { key: "build" as const, label: "Build & Registry", value: readiness?.worker.online ?? 0, unit: "workers online", icon: Hammer },
            { key: "panel" as const, label: "Panel", value: panel ? panel.status : "—", unit: panel ? "Self-hosted" : "External", icon: Settings },
            { key: "users" as const, label: "Users & Security", value: users.length, unit: require2fa ? "users · 2FA required" : "users", icon: Users },
          ].map((item) => (
            <button key={item.key} type="button" onClick={() => setSection(item.key)} className="group flex min-h-28 w-full flex-col justify-between px-5 py-4 text-left transition-colors hover:bg-brand/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset">
              <span className="flex w-full items-center gap-2.5 text-sm font-medium text-fg">
                <item.icon size={16} className="shrink-0 text-muted transition-colors group-hover:text-fg" />
                {item.label}
                <ArrowRight size={14} className="ml-auto text-muted transition-colors group-hover:text-fg" />
              </span>
              <span className="mt-4 flex min-w-0 items-baseline gap-2">
                <strong className="truncate text-xl font-semibold tabular-nums tracking-tight text-fg">{typeof item.value === "string" && item.key === "panel" ? humanize(item.value) : item.value}</strong>
                <span className="truncate text-xs text-muted">{item.unit}</span>
              </span>
            </button>
          ))}
        </div></div>
      )}

      {section === "hetzner" && <Card className="overflow-hidden">
        <CardHeader
          icon={<HetznerIcon size={15} />}
          title="Hetzner"
          description={`Cloud API ${hetznerStatus.configured ? "connected" : "not configured"} · Object Storage ${hetznerStatus.s3Configured ? `connected (${settingsForm.hetzner_s3_region})` : "not configured"}`}
          actions={<Btn size="xs" onClick={() => setHetznerEditing((open) => !open)}>{hetznerEditing ? "Close" : "Edit"}</Btn>}
        />
        {!hetznerEditing && <div>
          <DataRow label="Cloud API">{hetznerStatus.configured ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">Not configured</Badge>}</DataRow>
          <DataRow label="Object Storage">{hetznerStatus.s3Configured ? <Badge tone="success">Connected · {settingsForm.hetzner_s3_region}</Badge> : <Badge>Not configured</Badge>}</DataRow>
        </div>}
        {hetznerEditing && <div className="animate-slide-up">
          <div className="px-4">
            <Field divider label="API token" align="start" hint="Hetzner Cloud API token with read & write access. OCD uses it to create servers, volumes, networks, and firewalls.">
              <input type="password" value={settingsForm.hetzner_api_token} onChange={setS("hetzner_api_token")} placeholder="Hetzner API token" autoComplete="new-password" />
            </Field>
          </div>
          <div className="border-t px-4 pt-4">
            <h3 className="text-sm font-semibold text-fg">Hetzner Object Storage</h3>
            <p className="mt-0.5 text-xs text-muted">Generate S3 credentials in Hetzner Console. These are separate from the Cloud API token and are stored encrypted by OCD.</p>
          </div>
          <div className="px-4">
            <Field divider label="Region">
              <NeoSelect
                value={settingsForm.hetzner_s3_region}
                onChange={(v) => setSettingsForm((f) => ({ ...f, hetzner_s3_region: v }))}
                options={hetznerStatus.s3Regions.map((region) => ({ value: region, label: region }))}
              />
            </Field>
            <Field divider label="Access key">
              <input type="password" value={settingsForm.hetzner_s3_access_key} onChange={setS("hetzner_s3_access_key")} placeholder="Hetzner S3 access key" autoComplete="off" />
            </Field>
            <Field divider label="Secret key" align="start" hint="Clear both key fields and save to disconnect Object Storage.">
              <input type="password" value={settingsForm.hetzner_s3_secret_key} onChange={setS("hetzner_s3_secret_key")} placeholder="Hetzner S3 secret key" autoComplete="new-password" />
            </Field>
          </div>
          <div className={FORM_FOOTER}>
            <Btn onClick={() => setHetznerEditing(false)}>Cancel</Btn>
            <Btn variant="primary" loading={saving} onClick={saveHetzner}><Save size={14} /> Save</Btn>
          </div>
        </div>}
      </Card>}

      {/* Instance Settings */}
      {section === "infrastructure" && <Card className="overflow-hidden">
        <CardHeader
          icon={<ServerIcon size={15} />}
          title="Infrastructure settings"
          description={settingsForm.default_domain_suffix || "No default app domain"}
          actions={<Btn size="xs" onClick={() => setInfrastructureEditing((open) => !open)}>{infrastructureEditing ? "Close" : "Edit"}</Btn>}
        />
        {!infrastructureEditing && <div>
          <DataRow label="App domain" mono>{settingsForm.default_domain_suffix || <span className="font-sans text-sm text-muted">Not set</span>}</DataRow>
        </div>}
        {infrastructureEditing && <div className="animate-slide-up">
          <div className="px-4">
            <Field divider label="App domain" align="start" hint="Used as the default domain suffix. OCD shows the DNS records to create but never changes DNS.">
              <input type="text" className="font-mono" value={settingsForm.default_domain_suffix} onChange={setS("default_domain_suffix")} placeholder="apps.example.com" />
            </Field>
          </div>
          <div className={FORM_FOOTER}>
            <Btn onClick={() => setInfrastructureEditing(false)}>Cancel</Btn>
            <Btn variant="primary" loading={saving} onClick={saveSettings}><Save size={14} /> Save</Btn>
          </div>
        </div>}
      </Card>}

      {/* Build connections are explicit capabilities, not generic settings. */}
      {section === "build" && <Card className="overflow-hidden">
        <CardHeader
          icon={<Key size={15} />}
          title={<span className="inline-flex items-center gap-1">Build connections <InfoTip>Credentials are encrypted and sent only to the configured Git host or registry scope.</InfoTip></span>}
          description="Registry and private source credentials used by build workers"
        />

        <div className="border-b">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted"><Package size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-sm font-medium text-fg">
                OCI registry
                <InfoTip>Works with GHCR, GitLab, Docker Hub, Quay, Harbor, and self-hosted OCI registries.</InfoTip>
              </div>
              {registryConnected && !registryEditing
                ? <div className="break-all font-mono text-xs text-muted">{settingsForm.oci_artifact_ref || readiness?.registry.scope}</div>
                : <div className="text-xs text-muted">Push and pull built images</div>}
            </div>
            <Badge tone={registryConnected ? "success" : "warning"}>{registryConnected ? "Connected" : "Not connected"}</Badge>
            <Btn size="xs" onClick={() => setRegistryEditing((open) => !open)}>{registryEditing ? "Close" : registryConnected ? "Edit" : "Configure"}</Btn>
          </div>
          {registryEditing && <div className="animate-slide-up border-t bg-canvas/40">
            <div className="px-4">
              <Field divider label="Registry scope" align="start" hint="The credential boundary, such as registry.example.com/team. Credentials are never sent to another scope on the same registry.">
                <input type="text" className="font-mono" value={settingsForm.oci_artifact_ref} onChange={setS("oci_artifact_ref")} placeholder="registry.example.com/team" />
              </Field>
              <Field divider label="Username">
                <input type="text" value={settingsForm.oci_registry_username} onChange={setS("oci_registry_username")} placeholder="acme" />
              </Field>
              <Field divider label={registryConnected ? "New token (only to update)" : "Password / token"}>
                <input type="password" value={settingsForm.oci_registry_password} onChange={setS("oci_registry_password")} placeholder={registryConnected ? "Leave empty to keep current connection" : "Registry password or token"} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-subtle/40 px-4 py-3">
              <div>{registryConnected && <Btn variant="ghost" disabled={connectionBusy !== null} onClick={disconnectRegistry}><Trash2 size={14} /> Disconnect</Btn>}</div>
              <Btn variant="primary" loading={connectionBusy === "registry"} disabled={!settingsForm.oci_registry_password} onClick={connectRegistry}>
                <Key size={14} /> {registryConnected ? "Update connection" : "Connect registry"}
              </Btn>
            </div>
          </div>}
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">{(() => { const SourceIcon = gitHostIcon(settingsForm.github_build_host || readiness?.source.host); return <SourceIcon size={15} />; })()}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 text-sm font-medium text-fg">
                Private Git repositories
                <InfoTip>Public repositories work without credentials. Configure this only for private repositories on an HTTPS Git host.</InfoTip>
              </div>
              {sourceConnected && !sourceEditing
                ? <div className="break-all font-mono text-xs text-muted">{settingsForm.github_build_host || readiness?.source.host}</div>
                : <div className="text-xs text-muted">Check out private repositories over HTTPS</div>}
            </div>
            <Badge tone={sourceConnected ? "success" : "neutral"}>{sourceConnected ? "Connected" : "Public only"}</Badge>
            <Btn size="xs" onClick={() => setSourceEditing((open) => !open)}>{sourceEditing ? "Close" : sourceConnected ? "Edit" : "Configure"}</Btn>
          </div>
          {sourceEditing && <div className="animate-slide-up border-t bg-canvas/40">
            <div className="px-4">
              <Field divider label="Git host">
                <input type="text" className="font-mono" value={settingsForm.github_build_host} onChange={setS("github_build_host")} placeholder="git.example.com" />
              </Field>
              <Field divider label="Git username" align="start" hint="Host-specific. GitHub commonly uses x-access-token.">
                <input type="text" value={settingsForm.github_build_username} onChange={setS("github_build_username")} placeholder="git-user" />
              </Field>
              <Field divider label={sourceConnected ? "New read-only token (only to update)" : "Read-only token"}>
                <input type="password" value={settingsForm.github_build_token} onChange={setS("github_build_token")} placeholder={sourceConnected ? "Leave empty to keep current connection" : "Token for private checkout"} />
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-subtle/40 px-4 py-3">
              <div>{sourceConnected && <Btn variant="ghost" disabled={connectionBusy !== null} onClick={disconnectSource}><Trash2 size={14} /> Disconnect</Btn>}</div>
              <Btn variant="primary" loading={connectionBusy === "source"} disabled={!settingsForm.github_build_host || !settingsForm.github_build_username || !settingsForm.github_build_token} onClick={connectSource}>
                <Key size={14} /> {sourceConnected ? "Update connection" : "Connect source"}
              </Btn>
            </div>
          </div>}
        </div>
      </Card>}

      {/* OCD BuildKit workers */}
      {section === "build" && <Card className="overflow-hidden">
        <CardHeader
          icon={<Hammer size={15} />}
          title={<span className="inline-flex items-center gap-1">Build workers <InfoTip>Workers check out an exact commit, build and push its image, then deploy the immutable digest. GitHub push webhooks can trigger builds automatically.</InfoTip></span>}
          description={`${runners.length} worker${runners.length === 1 ? "" : "s"}`}
          actions={<>
            <Btn size="xs" variant="ghost" onClick={refreshRunners}><RefreshCw size={12} /> Refresh</Btn>
            <Btn size="xs" variant={addingWorker ? "default" : "primary"} onClick={() => setAddingWorker((open) => !open)}><Plus size={12} /> {addingWorker ? "Close" : "Add worker"}</Btn>
          </>}
        />

        {runners.length > 0 && (
          <Table headers={["Worker", "Server", "Status", "Version", "Disk", ""]}>
            {runners.map((runner) => (
              <tr key={runner.id}>
                <td className="font-mono text-xs text-fg">{runner.name}</td>
                <td className="font-mono text-xs text-fg-dim">{runner.server?.name || "Missing"}</td>
                <td><StatusBadge status={runner.status} />{runner.last_error && <div className="mt-1 max-w-xs break-words text-xs text-danger">{runner.last_error}</div>}</td>
                <td className="font-mono text-xs text-fg-dim">{runner.worker_version || "—"}<div className="text-muted">{runner.architecture || "—"}</div></td>
                <td className="whitespace-nowrap font-mono text-xs tabular-nums text-fg-dim">{runner.disk_free_bytes ? `${(runner.disk_free_bytes / 1024 ** 3).toFixed(1)} GB` : "—"}</td>
                <td className="w-10 text-right"><Btn size="xs" variant="ghost" title="Remove worker" disabled={runnerBusy} onClick={() => removeRunner(runner)}><Trash2 size={14} /></Btn></td>
              </tr>
            ))}
          </Table>
        )}
        {runners.length === 0 && !addingWorker && <EmptyState icon={Hammer} message="No build workers" description="Add a worker on an empty server to build images from source." />}

        {addingWorker && <div className={`animate-slide-up bg-canvas/40 ${runners.length > 0 ? "border-t" : ""}`}>
          <div className="px-4 pt-4">
            <h3 className="text-sm font-semibold text-fg">Add build worker</h3>
          </div>
          <div className="px-4">
            <Field divider label="Build server" align="start" hint="Choose an empty server. The panel host and servers already running apps cannot become build workers.">
              <NeoSelect
                value={runnerForm.server_id}
                onChange={(serverId) => setRunnerForm((current) => ({ ...current, server_id: serverId }))}
                options={availableRunnerServers.map((server) => ({
                  value: String(server.id),
                  label: server.name,
                }))}
                placeholder="Select server"
              />
            </Field>
            {workerAdvanced && <>
              <Field divider label="Worker name" align="start" hint="Optional. Defaults to ocd-<server>.">
                <input className="font-mono" value={runnerForm.name} onChange={(event) => setRunnerForm((current) => ({ ...current, name: event.target.value }))} placeholder="ocd-build-1" />
              </Field>
              <Field divider label="Conversion token" align="start" hint="Only needed when converting an existing GitHub Actions runner. New workers leave this empty.">
                <input type="password" value={runnerForm.removal_token} onChange={(event) => setRunnerForm((current) => ({ ...current, removal_token: event.target.value }))} placeholder="Optional conversion token" />
              </Field>
            </>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-subtle/40 px-4 py-3">
            <button type="button" onClick={() => setWorkerAdvanced((open) => !open)} className="inline-flex items-center gap-1 rounded text-sm text-muted transition-colors hover:text-fg">
              <ChevronDown size={14} className={`transition-transform ${workerAdvanced ? "rotate-180" : ""}`} />
              {workerAdvanced ? "Hide advanced options" : "Advanced options"}
            </button>
            <Btn variant="primary" loading={runnerBusy} disabled={!runnerForm.server_id} onClick={installRunner}><Hammer size={14} /> Install worker</Btn>
          </div>
        </div>}

        {buildSources.length > 0 && <div className="border-t">
          <div className="flex items-center gap-2 px-4 py-3">
            <GitHubIcon size={15} className="text-fg" />
            <h3 className="text-sm font-semibold text-fg">GitHub push webhooks</h3>
          </div>
          <div className="border-t">
            <Table headers={["Source", "Branch", "Status", "Webhook", ""]}>
              {buildSources.map((source) => <tr key={source.id}>
                <td className="break-all font-mono text-xs text-fg">{source.repository}</td>
                <td className="font-mono text-xs text-fg-dim">{source.branch}</td>
                <td><StatusBadge status={source.last_status || "idle"} />{source.last_error && <div className="mt-1 max-w-xs break-words text-xs text-danger">{source.last_error}</div>}</td>
                <td>{source.webhook_secret_configured ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Missing</Badge>}</td>
                <td className="text-right"><Btn size="xs" onClick={() => rotateWebhook(source)}><Key size={12} /> Rotate</Btn></td>
              </tr>)}
            </Table>
          </div>
        </div>}
        {shownWebhook && <div className="border-t p-4">
          <InlineNotice tone="warning" title="Webhook secret — shown once">
            <div className="mt-2 space-y-2">
              <div className="flex min-w-0 items-center gap-2"><span className="w-14 shrink-0 text-xs text-muted">URL</span><code className="min-w-0 flex-1 select-all break-all rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">{shownWebhook.url}</code><CopyButton text={shownWebhook.url} /></div>
              <div className="flex min-w-0 items-center gap-2"><span className="w-14 shrink-0 text-xs text-muted">Secret</span><code className="min-w-0 flex-1 select-all break-all rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">{shownWebhook.secret}</code><CopyButton text={shownWebhook.secret} /></div>
              <div className="flex items-center gap-1 text-xs text-muted">Webhook setup <InfoTip>Use content type application/json and subscribe to push events only.</InfoTip></div>
            </div>
          </InlineNotice>
        </div>}
      </Card>}

      {/* Panel */}
      {section === "panel" && <><PanelProtection /><AdminNtfySettings /></>}
      {section === "panel" && !panel && <Card><EmptyState icon={ServerIcon} message="Not a self-hosted panel" description="This instance is not managed as a self-hosted panel app." /></Card>}
      {section === "panel" && panel && (
        <Card className="overflow-hidden">
          <CardHeader icon={<ServerIcon size={15} />} title="Panel (self-hosted)" description="The OCD panel running as a managed app" actions={<StatusBadge status={panel.status} />} />

          <div>
            <DataRow label="Domain" mono>
              <a href={`https://${panel.domain}`} target="_blank" rel="noreferrer" className="break-all text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">{panel.domain}</a>
            </DataRow>
            <DataRow label="Container" mono>{panel.name}</DataRow>
            <DataRow label="Server" mono>{panelServer ? `${panelServer.name} (${panelServer.ipv4})` : "—"}</DataRow>
            <DataRow label="Image" mono><span className="min-w-0 break-all">{deployedPanelImage}</span>{deployedPanelImage !== "—" && <CopyButton text={deployedPanelImage} />}</DataRow>
            <DataRow label="Volume" mono><span className="min-w-0 break-all">{panel.volume_mount || "—"}</span></DataRow>
          </div>

          {panel.dns_instruction && <div className="border-t p-4"><DnsInstructionView value={panel.dns_instruction} /></div>}

          <div className="border-t">
            <div className="px-4 pt-4">
              <h3 className="text-sm font-semibold text-fg">Manual panel redeploy</h3>
              <p className="mt-0.5 text-sm text-fg-dim">Release the image built for the latest commit on main. If it is already running, this restarts the same version.</p>
            </div>
            {latestPanelRelease && <div className="mx-4 mt-3 space-y-1 rounded-lg border bg-canvas/50 px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted">Latest main</span>
                <code className="font-mono font-medium text-fg">{latestPanelRelease.commit.slice(0, 12)}</code>
                <Badge tone={latestPanelRelease.upToDate ? "success" : "info"}>{latestPanelRelease.upToDate ? "currently deployed" : "new image available"}</Badge>
              </div>
              <div className="break-all font-mono text-muted">{latestPanelRelease.image}</div>
            </div>}
            {latestPanelError && <p className="mx-4 mt-3 text-xs text-danger" role="alert">{latestPanelError}</p>}
            <div className="flex flex-wrap items-center gap-2 px-4 py-4">
              <Btn variant="primary" disabled={!latestPanelRelease || latestPanelLoading || panelBusy} loading={panelBusy} onClick={redeployLatestPanel}>
                <RefreshCw size={14} /> {latestPanelRelease?.upToDate ? "Redeploy current panel" : "Redeploy latest main"}
              </Btn>
              <Btn disabled={latestPanelLoading || panelBusy} loading={latestPanelLoading} onClick={() => void refreshLatestPanelRelease()}>Refresh target</Btn>
              <Btn size="xs" variant="ghost" className="sm:ml-auto" onClick={() => setPanelReleaseOpen((open) => !open)}>
                <ChevronDown size={14} className={`transition-transform ${panelReleaseOpen ? "rotate-180" : ""}`} /> {panelReleaseOpen ? "Hide specific image" : "Advanced: redeploy a specific image"}
              </Btn>
            </div>
            {panelReleaseOpen && <div className="animate-slide-up border-t bg-canvas/40">
              <div className="px-4">
                <Field label="New panel image" align="start" wide hint="Build and publish the image in CI, then paste its digest-qualified reference here.">
                  <input type="text" className="font-mono" value={panelImage} onChange={(event) => setPanelImage(event.target.value)} placeholder="ghcr.io/owner/ocd@sha256:..." />
                </Field>
              </div>
              <div className={FORM_FOOTER}>
                <Btn variant="primary" loading={panelBusy} onClick={redeployPanelNow}>
                  <RefreshCw size={14} /> Redeploy panel image
                </Btn>
              </div>
            </div>}
          </div>

          {panelDeployments.length > 0 && (
            <div className="border-t">
              <div className="flex items-center gap-2 px-4 py-3">
                <History size={15} className="text-muted" />
                <h4 className="text-sm font-semibold text-fg">Recent deployments</h4>
              </div>
              <div className="max-h-56 divide-y overflow-y-auto border-t">
                {panelDeployments.slice(0, 10).map((d) => (
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

      {section === "users" && <Card className="overflow-hidden">
        <CardHeader
          icon={<GitHubIcon size={15} className="text-fg" />}
          title="GitHub sign-in"
          description={settingsForm.github_oauth_client_id ? "Configured" : "Not configured"}
          actions={<Btn size="xs" onClick={() => setOauthEditing((open) => !open)}>{oauthEditing ? "Close" : settingsForm.github_oauth_client_id ? "Edit" : "Configure"}</Btn>}
        />
        {!oauthEditing && <DataRow label="Client ID" mono>{settingsForm.github_oauth_client_id || <span className="font-sans text-sm text-muted">Not set</span>}</DataRow>}
        {oauthEditing && <div className="animate-slide-up">
          <div className="px-4"><GitHubOAuthSettings form={settingsForm} setS={setS} /></div>
          <div className={FORM_FOOTER}>
            <Btn onClick={() => setOauthEditing(false)}>Cancel</Btn>
            <Btn variant="primary" loading={saving} onClick={saveSettings}><Save size={14} /> Save</Btn>
          </div>
        </div>}
      </Card>}

      {/* Users */}
      {section === "users" && <Card className="overflow-hidden">
        <CardHeader
          icon={<Users size={15} />}
          title="Users"
          description={`${users.length} user${users.length === 1 ? "" : "s"}`}
          actions={<Btn variant={showCreate ? "default" : "primary"} onClick={() => setShowCreate(!showCreate)}><Plus size={14} /> Create user</Btn>}
        />

        {showCreate && (
          <form onSubmit={handleCreate} className="animate-slide-up border-b bg-canvas/40">
            <div className="px-4">
              <Field divider label="Username">
                <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="username" required />
              </Field>
              <Field divider label="Password">
                <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min 8 characters" required />
              </Field>
            </div>
            <div className={FORM_FOOTER}>
              <Btn onClick={() => setShowCreate(false)}>Cancel</Btn>
              <Btn type="submit" variant="primary" loading={creating}>Create</Btn>
            </div>
          </form>
        )}

        <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 border-b bg-subtle/30 px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2.5">
            <ShieldAlert size={15} className="shrink-0 text-muted" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-fg">Require 2FA for new users</span>
            </span>
          </span>
          <input type="checkbox" aria-label="Require 2FA for new users" checked={require2fa} disabled={savingRequire2fa} onChange={(e) => toggleRequire2fa(e.target.checked)} />
        </label>

        {users.length === 0 ? <EmptyState icon={Users} message="No users" /> : <div className="divide-y">
          {users.map((u) => (
            <div
              key={u.id}
              role="link"
              tabIndex={0}
              onClick={() => { window.location.hash = `#/admin/${u.id}`; }}
              onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") window.location.hash = `#/admin/${u.id}`; }}
              className="flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-subtle/50 focus-visible:bg-subtle/50 focus-visible:outline-none max-md:min-h-16"
            >
              <span aria-hidden="true" className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border text-xs font-semibold ${u.isAdmin ? "border-warning/30 bg-warning/10 text-warning" : "bg-subtle text-fg-dim"}`}>
                {initials(u.username)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{u.username}</span>
                  {u.isAdmin
                    ? <Badge tone="warning"><ShieldCheck size={11} /> Admin</Badge>
                    : <Badge><Shield size={11} /> User</Badge>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span className="tabular-nums">Created {new Date(u.createdAt + "Z").toLocaleDateString()}</span>
                  <span className="sm:hidden">· {u.webauthnEnabled ? "Passkey" : "No 2FA"}</span>
                  <span className="sm:hidden">· {u.isAdmin ? "All" : u.permissions.length} permissions</span>
                </div>
              </div>
              <div className="hidden w-24 shrink-0 sm:block">
                {u.webauthnEnabled
                  ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-dim"><Fingerprint size={13} className="text-success" /> Passkey</span>
                  : <span className="text-xs text-muted">No 2FA</span>}
              </div>
              <div className="hidden w-24 shrink-0 sm:block">
                <span className="inline-flex items-center gap-1.5 text-xs text-fg-dim">
                  <Key size={13} className="text-muted" /> <span className="tabular-nums">{u.isAdmin ? "All" : `${u.permissions.length}`}</span>
                </span>
              </div>
              <div className="flex w-8 shrink-0 justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {!u.isAdmin && (
                  <Btn size="xs" variant="ghost" title={`Delete ${u.username}`} onClick={() => handleDelete(u)}>
                    <Trash2 size={14} />
                  </Btn>
                )}
              </div>
              <ChevronRight size={15} className="hidden shrink-0 text-muted sm:block" />
            </div>
          ))}
        </div>}
      </Card>}
    </PageShell>
  );
}
