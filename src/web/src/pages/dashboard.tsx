import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { Badge, Card, CardHeader, StatusBadge, Stat, Btn, EmptyState, SegmentedControl, showToast, CopyButton, PageShell, PageSection, PageHeader, PageState, statusTone } from "../components/ui.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { RefreshCw, Server, LayoutGrid, List, ExternalLink, Box, Boxes, ChevronDown } from "lucide-react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";

type AppData = {
  id: number; name: string; domain: string; image_ref?: string; status: string;
  container_port: number;
  placement?: Array<{ server_id: number; server_name: string; replicas: number }>;
  public: number;
  internal_protocol?: string;
  stack_id?: number | null;
  environment_stale?: number;
};
type StackData = {
  id: number; name: string; status: string; created_at: string;
  environment_id: number | null; app_count: number;
};
type DashboardData = { apps: AppData[] };
type ServerData = {
  id: number; name: string; status: string; type: string; location: string; ipv4: string;
  build_worker?: boolean; apps?: Array<{ id: number; name: string; status: string }>;
};
type AppView = "cards" | "list";
const APP_VIEW_KEY = "ocd.dashboard.appView";

const APP_OP_KINDS = new Set([
  "restart_app", "pause_app", "unpause_app", "redeploy", "destroy_app", "move",
]);
const STACK_OP_KINDS = new Set([
  "deploy_stack", "destroy_stack", "cascade_redeploy",
]);

export function DashboardPage() {
  const isMobile = useMobileLayout();
  const [data, setData] = useState<DashboardData>({ apps: [] });
  const [stacks, setStacks] = useState<StackData[]>([]);
  // Hero figures outside the app list. Null when the viewer may not read them,
  // so the tile can say so instead of showing a misleading zero.
  const [servers, setServers] = useState<ServerData[] | null>(null);
  const [activeIncidents, setActiveIncidents] = useState<number | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  // Cards or list for the applications section, remembered per browser.
  const [appView, setAppView] = useState<AppView>(() => {
    try { return localStorage.getItem(APP_VIEW_KEY) === "cards" ? "cards" : "list"; } catch { return "list"; }
  });
  const changeAppView = (view: AppView) => {
    setAppView(view);
    try { localStorage.setItem(APP_VIEW_KEY, view); } catch { /* per-browser convenience only */ }
  };
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Cards view opens one stack at a time; the list keeps its own expanded set.
  const [openStack, setOpenStack] = useState<number | null>(null);
  const seenStacks = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);

  // Watch CLI-initiated work so the list refreshes as it lands.
  const ops = useActiveOperations((op) => APP_OP_KINDS.has(op.kind) || STACK_OP_KINDS.has(op.kind));

  const load = async () => {
    try {
      const [dash, stackList] = await Promise.all([
        get("/api/dashboard") as Promise<DashboardData>,
        get("/api/stacks") as Promise<StackData[]>,
      ]);
      setData(dash);
      setStacks(stackList);
      setLoadedAt(new Date());
      void Promise.all([
        (get("/api/servers") as Promise<ServerData[]>).then((rows) => setServers(rows ?? []), () => setServers(null)),
        (get("/api/incidents?status=active&offset=0") as Promise<{ counts: { active: number } }>).then((res) => setActiveIncidents(res.counts.active), () => setActiveIncidents(null)),
      ]);
      // Auto-expand a stack the first time we see it; preserve the user's
      // collapse choices across the reconciler's polling reloads.
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const s of stackList) {
          if (!seenStacks.current.has(s.id)) {
            seenStacks.current.add(s.id);
            next.add(s.id);
          }
        }
        return next;
      });
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Refetch state whenever the set of active ops changes — catches both enqueue
  // (op appears) and terminal (op drops out after ~2s linger).
  const activeSig = ops.active.map((o) => `${o.id}:${o.status}`).join(",");
  useEffect(() => {
    if (!loading) load();
  }, [activeSig]);

  const appBusyKind = (appId: number) => ops.byResourceKey(`app:${appId}`)?.kind;
  const stackBusyKind = (stackId: number) => ops.byResourceKey(`stack:${stackId}`)?.kind;

  const toggleStack = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // --- Row renderers (shared between top-level and stack-nested placement) ---

  const appAddress = (app: AppData) => {
    if (app.domain) return { label: app.domain, href: `https://${app.domain}`, copy: `https://${app.domain}`, private: false };
    const host = app.internal_protocol === "tcp" ? `${app.name}.ocd.internal:${app.container_port}` : `${app.name}.ocd.internal`;
    const copy = app.internal_protocol === "tcp" ? `tcp://${host}` : `http://${host}`;
    return { label: host, href: undefined, copy, private: !app.public };
  };

  const renderAppRow = (app: AppData, opts?: { nested?: boolean }) => {
    const nested = opts?.nested ?? false;
    const rowBusy = !!appBusyKind(app.id);
    // Scope disabling to this app's own in-flight op — the engine serializes per
    // `app:${id}`, so another app being busy is irrelevant here.
    const disableRow = rowBusy;
    const address = appAddress(app);
    return (
      <div
        key={`app-${app.id}`}
        className={`group relative flex items-center justify-between gap-4 py-3 pr-3 transition-colors hover:bg-subtle/50 ${nested ? "pl-12" : "pl-4"} ${rowBusy ? "bg-subtle/40" : ""}`}
      >
        <div className={`flex min-w-0 flex-1 items-center gap-3 ${app.status === "paused" ? "opacity-60" : ""}`}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">
            <Box size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <a href={`#/apps/${app.id}`} className="truncate text-sm font-medium text-fg">{app.name}</a>
              {address.private && <Badge>Private</Badge>}
              {(app.placement ?? []).reduce((sum, entry) => sum + entry.replicas, 0) > 1 && <Badge>{(app.placement ?? []).reduce((sum, entry) => sum + entry.replicas, 0)} replicas</Badge>}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-muted">
              {address.href ? (
                <a href={address.href} target="_blank" rel="noopener" className="flex min-w-0 items-center gap-1 transition-colors hover:text-fg" title={address.label}>
                  <span className="truncate font-mono text-xs">{address.label}</span>
                  <ExternalLink size={11} className="shrink-0" />
                </a>
              ) : (
                <span className="truncate font-mono text-xs" title={address.label}>{address.label}</span>
              )}
              <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <CopyButton text={address.copy} size={11} />
              </span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusBadge
            status={app.status}
            subLabel={app.environment_stale ? "stale environment" : undefined}
          />
        </div>
      </div>
    );
  };

  // `stack` gives the card a light brand tint when it is shown as a member
  // of an open stack.
  const renderAppCard = (app: AppData, stack?: StackData) => {
    const busy = !!appBusyKind(app.id);
    const address = appAddress(app);
    const replicas = (app.placement ?? []).reduce((sum, entry) => sum + entry.replicas, 0);
    const tone = stack
      ? "bg-brand/5 hover:bg-brand/10"
      : busy ? "bg-subtle/40 hover:bg-subtle/50" : "hover:bg-subtle/50";
    return (
      <div key={`app-card-${app.id}`} className={`group flex min-h-[136px] min-w-0 flex-col gap-3 p-4 transition-colors ${tone}`}>
        <div className="flex items-start gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md border bg-subtle text-muted ${app.status === "paused" ? "opacity-60" : ""}`}><Box size={16} /></span>
          <div className="min-w-0 flex-1">
            <a href={`#/apps/${app.id}`} className="block truncate text-sm font-semibold text-fg">{app.name}</a>
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-muted">
              {address.href ? (
                <a href={address.href} target="_blank" rel="noopener" className="flex min-w-0 items-center gap-1 transition-colors hover:text-fg" title={address.label}>
                  <span className="truncate font-mono text-xs">{address.label}</span>
                  <ExternalLink size={11} className="shrink-0" />
                </a>
              ) : (
                <span className="truncate font-mono text-xs" title={address.label}>{address.label}</span>
              )}
              <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <CopyButton text={address.copy} size={11} />
              </span>
            </div>
          </div>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <StatusBadge status={app.status} subLabel={app.environment_stale ? "stale environment" : undefined} />
          {address.private && <Badge>Private</Badge>}
          {replicas > 1 && <Badge>{replicas} replicas</Badge>}
        </div>
      </div>
    );
  };

  // A stack as a card, brand-tinted with a solid stack icon, so it stands
  // apart from the app cards. Clicking it opens
  // its apps right after it in the grid; one stack is open at a time.
  const renderStackCard = (stack: StackData, members: AppData[]) => {
    const open = openStack === stack.id;
    const toggle = () => setOpenStack(open ? null : stack.id);
    return (
      <div
        key={`stack-card-${stack.id}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } }}
        className={`group flex min-h-[136px] min-w-0 cursor-pointer flex-col gap-3 p-4 transition-colors ${open ? "bg-brand/20" : "bg-brand/10 hover:bg-brand/15"}`}
      >
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-brand text-brand-fg"><Boxes size={16} /></span>
          <div className="min-w-0 flex-1">
            <a href={`#/stacks/${stack.id}`} onClick={(event) => event.stopPropagation()} className="block truncate text-sm font-semibold text-fg">{stack.name}</a>
            <div className="mt-0.5 truncate text-xs text-muted">Stack · {members.length} app{members.length === 1 ? "" : "s"}</div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
            <Btn variant="ghost" title={open ? "Close" : "Open"} onClick={toggle}>
              <ChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} />
            </Btn>
          </div>
        </div>
        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-1.5">
          <StatusBadge status={stack.status} />
          {members.slice(0, 3).map((app) => <Badge key={app.id} className="max-w-[140px]"><span className="truncate font-mono">{app.name}</span></Badge>)}
          {members.length > 3 && <Badge>+{members.length - 3}</Badge>}
        </div>
      </div>
    );
  };

  const renderStackGroup = (stack: StackData, members: { apps: AppData[] }) => {
    const isOpen = expanded.has(stack.id);
    const memberApps = members.apps;
    const memberBusy = memberApps.some((a) => !!appBusyKind(a.id));
    const stackKind = stackBusyKind(stack.id);
    const busy = !!stackKind || memberBusy;
    const total = memberApps.length;

    return (
      // A stack reads as one group: a brand-tinted band holding its header
      // and its member rows.
      <div key={`stack-${stack.id}`} className={`relative ${busy ? "bg-subtle/60" : "bg-brand/5"}`}>
        <div
          className="flex cursor-pointer items-center justify-between gap-4 py-3 pl-4 pr-3 transition-colors hover:bg-subtle/50"
          onClick={() => toggleStack(stack.id)}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand text-brand-fg">
              <Boxes size={15} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <a
                  href={`#/stacks/${stack.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="truncate text-sm font-medium text-fg"
                >{stack.name}</a>
                <Badge>Stack</Badge>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {total} app{total === 1 ? "" : "s"} · created {new Date(stack.created_at.replace(" ", "T") + "Z").toLocaleDateString()}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <StatusBadge status={stack.status} />
            <div className="flex items-center gap-0.5">
              <Btn variant="ghost" title={isOpen ? "Collapse" : "Expand"} onClick={() => toggleStack(stack.id)}>
                <ChevronDown size={15} className={`transition-transform ${isOpen ? "" : "-rotate-90"}`} />
              </Btn>
            </div>
          </div>
        </div>

        {isOpen && total > 0 && (
          <div className="divide-y border-t bg-canvas/50">
            {memberApps.map((app) => renderAppRow(app, { nested: true }))}
          </div>
        )}
        {isOpen && total === 0 && (
          <div className="border-t py-3 pl-12 pr-4 text-sm text-muted">No members</div>
        )}
      </div>
    );
  };

  if (loading) return <PageState title="Loading overview" width="xl" />;

  const { apps } = data;

  // Split standalone resources from stack members; members render nested under
  // their stack, so they must not also appear as loose top-level rows.
  const standaloneApps = apps.filter((a) => a.stack_id == null);
  const appsByStack = new Map<number, AppData[]>();
  for (const a of apps) {
    if (a.stack_id != null) appsByStack.set(a.stack_id, [...(appsByStack.get(a.stack_id) ?? []), a]);
  }
  const nothingDeployed = apps.length === 0 && stacks.length === 0;
  const running = apps.filter((a) => statusTone(a.status) === "success").length;
  const attention = apps.filter((a) => statusTone(a.status) === "danger").length;
  const paused = apps.filter((a) => a.status === "paused").length;

  const emptyState = (
    <Card>
      <EmptyState
        message="Nothing deployed yet"
        icon={Box}
        description={<>Deploy your first app from the CLI with <code className="rounded bg-subtle px-1 py-0.5 font-mono text-xs text-fg">ocd deploy</code>; it will show up here.</>}
      />
    </Card>
  );

  const readyServers = servers?.filter((server) => server.status === "ready").length ?? 0;
  const incidents = activeIncidents ?? 0;
  const headline = nothingDeployed
    ? "Nothing deployed yet"
    : attention > 0
      ? `${attention} app${attention === 1 ? " needs" : "s need"} attention`
      : incidents > 0
        ? `Healthy, ${incidents} open incident${incidents === 1 ? "" : "s"}`
        : "Everything is healthy";
  const meta = nothingDeployed
    ? <>Deploy your first app from the CLI with <code className="font-mono">ocd deploy</code>.</>
    : [
        `${apps.length} app${apps.length === 1 ? "" : "s"}`,
        `${stacks.length} stack${stacks.length === 1 ? "" : "s"}`,
        servers && `${servers.length} server${servers.length === 1 ? "" : "s"}`,
        loadedAt && `updated ${loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      ].filter(Boolean).join(" · ");

  const header = (
    <PageHeader
      title={headline}
      description={meta}
      actions={<>
        <Btn variant="primary" onClick={() => { window.location.hash = "#/engine"; }}>View operations</Btn>
        <Btn onClick={load}><RefreshCw size={14} /> Refresh</Btn>
      </>}
    />
  );

  // Desktop: the stats row is a section of its own; below it the flush panel is
  // one grid of hairline cells, a wide applications column beside servers over
  // operations.
  const stats = (
    <div className="split-nodes grid grid-cols-2 sm:grid-cols-4 [&>*]:border-line max-sm:[&>*:nth-child(odd)]:border-r max-sm:[&>*:nth-child(n+3)]:border-t sm:[&>*+*]:border-l">
      <Stat label="Apps" value={apps.length} hint={`${running} running${paused > 0 ? ` · ${paused} paused` : ""}`} className="px-6 py-5" />
      <Stat label="Servers" value={servers ? servers.length : "—"} hint={servers ? `${readyServers} ready` : "No access"} className="px-6 py-5" />
      <Stat label="Need attention" value={attention} tone={attention > 0 ? "danger" : undefined} hint={attention > 0 ? "Failing or degraded" : "None"} className="px-6 py-5" />
      <Stat label="Open incidents" value={activeIncidents ?? "—"} tone={incidents > 0 ? "danger" : undefined} hint={activeIncidents == null ? "No access" : incidents > 0 ? <a href="#/incidents">Review now →</a> : "None"} className="px-6 py-5" />
    </div>
  );

  const headerLink = (href: string, label: string) => (
    <a href={href} className="text-xs font-medium text-muted transition-colors hover:text-fg">{label}</a>
  );

  // Servers as a grid of cards, a band of their own above the applications.
  const serversGrid = servers && (
    <>
      <CardHeader
        title="Servers"
        actions={headerLink("#/resources?section=servers", servers.length > 6 ? `View all ${servers.length}` : "Manage")}
      />
      {servers.length === 0 ? <p className="px-4 py-5 text-sm text-muted">No servers yet.</p> : (
        <div className="card-grid grid sm:grid-cols-2 lg:grid-cols-3">
          {servers.slice(0, 6).map((server) => {
            const hosted = server.apps ?? [];
            return (
              <a key={server.id} href={`#/resources/servers/${server.id}`} className="group flex min-h-[148px] min-w-0 flex-col gap-4 p-5 transition-colors hover:bg-subtle/50">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border bg-subtle text-muted"><Server size={16} /></span>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm font-semibold text-fg">{server.name}</div>
                      <div className="truncate text-xs text-muted">{[server.type?.toUpperCase(), server.location].filter(Boolean).join(" · ")}{server.build_worker ? " · build worker" : ""}</div>
                    </div>
                  </div>
                  <StatusBadge status={server.status} />
                </div>
                <div className="mt-auto flex items-end justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap gap-1">
                    {hosted.slice(0, 3).map((app) => <Badge key={app.id} className="max-w-[120px]"><span className="truncate font-mono">{app.name}</span></Badge>)}
                    {hosted.length > 3 && <Badge>+{hosted.length - 3}</Badge>}
                    {hosted.length === 0 && <span className="font-mono text-xs text-muted">{server.ipv4}</span>}
                  </div>
                  <div className="shrink-0 text-right leading-none">
                    <span className="font-mono text-2xl font-medium tabular-nums text-fg">{hosted.length}</span>
                    <span className="ml-1 text-xs text-muted">app{hosted.length === 1 ? "" : "s"}</span>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </>
  );

  if (isMobile) {
    const appCard = (app: AppData, nested = false) => {
      const busy = !!appBusyKind(app.id);
      const address = appAddress(app);
      return (
        <article
          key={`mobile-app-${app.id}`}
          onClick={() => { window.location.hash = `#/apps/${app.id}`; }}
          className={`flex items-center gap-3 px-4 py-3 active:bg-subtle ${app.status === "paused" ? "opacity-60" : ""} ${nested ? "pl-8" : ""}`}
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border bg-subtle text-muted"><Box size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-medium text-fg">{app.name}</h3>
              {address.private && <Badge>Private</Badge>}
            </div>
            <div className="mt-0.5 truncate font-mono text-xs text-muted">{address.label}</div>
            <div className="mt-1.5"><StatusBadge status={busy ? "working" : app.status} subLabel={app.environment_stale ? "config changed" : undefined} /></div>
          </div>
        </article>
      );
    };

    const stackCard = (stack: StackData) => {
      const memberApps = appsByStack.get(stack.id) ?? [];
      const open = expanded.has(stack.id);
      return (
        <section key={`mobile-stack-${stack.id}`} className="frame bg-surface">
          <div onClick={() => toggleStack(stack.id)} className="flex items-center gap-3 px-4 py-3 active:bg-subtle">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border bg-subtle text-muted"><Boxes size={18} /></span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-medium">{stack.name}</h3>
              <div className="mt-1 flex items-center gap-2"><StatusBadge status={stack.status} /><span className="text-xs text-muted">· {memberApps.length} app{memberApps.length === 1 ? "" : "s"}</span></div>
            </div>
            <ChevronDown size={18} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
          </div>
          {open && (
            <div className="divide-y border-t bg-canvas/50">
              {memberApps.map((app) => appCard(app, true))}
              {memberApps.length === 0 && <p className="p-4 text-center text-sm text-muted">No members</p>}
            </div>
          )}
        </section>
      );
    };

    return (
      <main className="animate-fade-in px-4 pb-6 pt-5">
        <div className="mb-5">{header}</div>

        {nothingDeployed ? emptyState : (
          <div className="space-y-3">
            {standaloneApps.length > 0 && (
              <div className="divide-y frame bg-surface">
                {standaloneApps.map((app) => appCard(app))}
              </div>
            )}
            {stacks.map(stackCard)}
          </div>
        )}

      </main>
    );
  }

  // Standalone apps and stacks in one sequence, by name: stacks are not
  // pinned above the apps.
  const entries = [
    ...standaloneApps.map((app) => ({ kind: "app" as const, name: app.name, app })),
    ...stacks.map((stack) => ({ kind: "stack" as const, name: stack.name, stack })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <PageShell width="xl" flush>
      {header}
      <PageSection>{stats}</PageSection>
      {serversGrid && <PageSection>{serversGrid}</PageSection>}
      <section className="flex flex-col">
        <CardHeader
          title="Applications"
          description={nothingDeployed ? undefined : `${standaloneApps.length} standalone · ${stacks.length} stack${stacks.length === 1 ? "" : "s"}`}
          actions={nothingDeployed ? undefined : (
            <SegmentedControl
              ariaLabel="Application view"
              value={appView}
              onChange={changeAppView}
              options={[
                { value: "cards", label: <><LayoutGrid size={14} /> Cards</> },
                { value: "list", label: <><List size={14} /> List</> },
              ]}
            />
          )}
        />
        {nothingDeployed ? (
          <EmptyState
            className="flex-1"
            message="Nothing deployed yet"
            icon={Box}
            description={<>Deploy your first app from the CLI with <code className="rounded bg-subtle px-1 py-0.5 font-mono text-xs text-fg">ocd deploy</code>; it will show up here.</>}
          />
        ) : appView === "cards" ? (
          <div className="card-grid grid border-b sm:grid-cols-2 xl:grid-cols-3">
            {entries.flatMap((entry) => {
              if (entry.kind === "app") return [renderAppCard(entry.app)];
              const members = appsByStack.get(entry.stack.id) ?? [];
              const card = renderStackCard(entry.stack, members);
              // An open stack's apps follow its card in the same flow.
              return openStack === entry.stack.id ? [card, ...members.map((app) => renderAppCard(app, entry.stack))] : [card];
            })}
          </div>
        ) : (
          <div className="divide-y border-b">
            {entries.map((entry) => entry.kind === "app"
              ? renderAppRow(entry.app)
              : renderStackGroup(entry.stack, { apps: appsByStack.get(entry.stack.id) ?? [] }))}
          </div>
        )}
      </section>
    </PageShell>
  );
}
