import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";
import { Badge, Card, CardHeader, StatusBadge, Stat, Btn, EmptyState, showToast, confirm, CopyButton, PageShell, PageHeader, PageState, statusTone } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { RefreshCw, Play, Pause, RotateCcw, Trash2, ExternalLink, Check, Box, Boxes, ChevronDown, MoreHorizontal, Settings2 } from "lucide-react";
import { useMobileLayout } from "../hooks/use-mobile-layout.ts";
import { MobileActionSheet, MobileSheetAction } from "../components/mobile-action-sheet.tsx";
import { ContextActionItem, ContextActionMenu } from "../components/context-action-menu.tsx";

type AppData = {
  id: number; name: string; domain: string; image_ref?: string; status: string;
  container_port: number;
  placement?: Array<{ server_id: number; server_name: string; replicas: number }>; volume_id: string;
  public: number; health_check: number;
  internal_protocol?: string;
  stack_id?: number | null;
  environment_stale?: number;
  // Carried purely so per-app controls can be gated against an
  // environment-scoped grant as well as an app-scoped one.
  environment_id?: number | null;
};
type StackData = {
  id: number; name: string; status: string; created_at: string;
  environment_id: number | null; app_count: number;
};
type DashboardData = { apps: AppData[] };

const APP_OP_KINDS = new Set([
  "restart_app", "pause_app", "unpause_app", "redeploy", "destroy_app",
]);
const STACK_OP_KINDS = new Set([
  "deploy_stack", "destroy_stack", "cascade_redeploy",
]);

const APP_ACTION_TO_KIND: Record<string, string> = {
  restart: "restart_app",
  pause: "pause_app",
  unpause: "unpause_app",
  delete: "destroy_app",
};
export function DashboardPage() {
  const isMobile = useMobileLayout();
  const [data, setData] = useState<DashboardData>({ apps: [] });
  const [stacks, setStacks] = useState<StackData[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const seenStacks = useRef<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const confirmTimeoutRef = useRef<number | null>(null);
  const [mobileSelection, setMobileSelection] = useState<
    { kind: "app" | "stack"; id: number } | null
  >(null);

  const ops = useActiveOperations(
    (op) => APP_OP_KINDS.has(op.kind) || STACK_OP_KINDS.has(op.kind),
    { rehydrateToasts: true },
  );

  const armOrRun = (key: string, run: () => void, close?: () => void) => {
    if (confirmKey === key) {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmKey(null);
      close?.();
      run();
    } else {
      if (confirmTimeoutRef.current) window.clearTimeout(confirmTimeoutRef.current);
      setConfirmKey(key);
      confirmTimeoutRef.current = window.setTimeout(() => setConfirmKey(null), 3000);
    }
  };

  const load = async () => {
    try {
      const [dash, stackList] = await Promise.all([
        get("/api/dashboard") as Promise<DashboardData>,
        get("/api/stacks") as Promise<StackData[]>,
      ]);
      setData(dash);
      setStacks(stackList);
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

  const appAction = async (action: string, appId: number) => {
    const key = `${action}-${appId}`;
    setActionLoading(key);
    try {
      if (action === "delete") {
        await runConfirmedCliAction(
          "app.delete",
          { app: String(appId) },
          { action: "delete_app", resourceType: "app", resourceId: appId },
        );
      } else {
        await runCliAction(`app.${action}`, { app: String(appId) });
      }
      showToast(`${action} successful`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };


  const stackDestroy = async (stack: StackData) => {
    if (!(await confirm(
      "Destroy Stack",
      `Permanently destroy "${stack.name}" and all ${stack.app_count} app(s)? Containers and routing are removed; environments are retained, and managed volumes are detached for recovery.`,
      true,
    ))) return;
    const key = `stack-delete-${stack.id}`;
    setActionLoading(key);
    try {
      await runConfirmedCliAction(
        "stacks.delete",
        { stack: String(stack.id) },
        { action: "delete_stack", resourceType: "stack", resourceId: stack.id },
      );
      showToast(`Destroyed stack ${stack.name}`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setActionLoading(null);
    }
  };

  const appBusyKind = (appId: number) => ops.byResourceKey(`app:${appId}`)?.kind;
  const stackBusyKind = (stackId: number) => ops.byResourceKey(`stack:${stackId}`)?.kind;

  const isAppActionLoading = (appId: number, action: string) => {
    const k = `${action}-${appId}`;
    return actionLoading === k || appBusyKind(appId) === APP_ACTION_TO_KIND[action];
  };

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
        className={`group flex items-center justify-between gap-4 py-3 pr-3 transition-colors hover:bg-subtle/50 ${nested ? "pl-12" : "pl-4"} ${rowBusy ? "bg-subtle/40" : ""}`}
      >
        <div className={`flex min-w-0 flex-1 items-center gap-3 ${app.status === "paused" ? "opacity-60" : ""}`}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">
            <Box size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <a href={`#/apps/${app.id}`} className="truncate text-sm font-medium text-fg hover:underline">{app.name}</a>
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
          <ContextActionMenu label={`Actions for ${app.name}`}>
            {(close) => <>
              <PermissionGate permission="apps.logs" appId={app.id} environmentId={app.environment_id}>
                <ContextActionItem icon={<Settings2 size={14} />} label="Open app" onClick={() => { close(); window.location.hash = `#/apps/${app.id}`; }} />
              </PermissionGate>
              <PermissionGate permission="apps.restart" appId={app.id} environmentId={app.environment_id}>
              {(() => {
                const k = `restart-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <ContextActionItem icon={armed ? <Check size={14} className="text-info" /> : <RotateCcw size={14} />} label={armed ? "Confirm restart" : "Restart"} loading={isAppActionLoading(app.id, "restart")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("restart", app.id), close)} />
                );
              })()}
              </PermissionGate>
              <PermissionGate permission="apps.pause" appId={app.id} environmentId={app.environment_id}>
              {app.status === "paused" ? (() => {
                const k = `unpause-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <ContextActionItem icon={armed ? <Check size={14} className="text-info" /> : <Play size={14} />} label={armed ? "Confirm unpause" : "Unpause"} loading={isAppActionLoading(app.id, "unpause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("unpause", app.id), close)} />
                );
              })() : (() => {
                const k = `pause-${app.id}`;
                const armed = confirmKey === k;
                return (
                  <ContextActionItem icon={armed ? <Check size={14} className="text-info" /> : <Pause size={14} />} label={armed ? "Confirm pause" : "Pause"} loading={isAppActionLoading(app.id, "pause")} disabled={disableRow && !armed} onClick={() => armOrRun(k, () => appAction("pause", app.id), close)} />
                );
              })()}
              </PermissionGate>
              <PermissionGate permission="apps.destroy" appId={app.id} environmentId={app.environment_id}>
              <div className="my-1 border-t" />
              <ContextActionItem
                icon={<Trash2 size={14} />}
                label="Destroy app"
                danger
                loading={isAppActionLoading(app.id, "delete")}
                disabled={disableRow}
                onClick={async () => {
                  close();
                  if (await confirm("Destroy app", `Permanently destroy "${app.name}"? This removes all containers. DNS remains unchanged and must be cleaned up manually.`, true)) {
                    appAction("delete", app.id);
                  }
                }}
              />
              </PermissionGate>
            </>}
          </ContextActionMenu>
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
    const destroying =
      actionLoading === `stack-delete-${stack.id}` || stackKind === "destroy_stack";
    const total = memberApps.length;

    return (
      <div key={`stack-${stack.id}`} className={busy ? "bg-subtle/40" : ""}>
        <div
          className="flex cursor-pointer items-center justify-between gap-4 py-3 pl-4 pr-3 transition-colors hover:bg-subtle/50"
          onClick={() => toggleStack(stack.id)}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">
              <Boxes size={15} />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <a
                  href={`#/stacks/${stack.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="truncate text-sm font-medium text-fg hover:underline"
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
              <PermissionGate permission="stacks.destroy" environmentId={stack.environment_id}>
                <Btn variant="ghost" title="Destroy stack" loading={destroying} disabled={busy} onClick={() => stackDestroy(stack)}>
                  <Trash2 size={15} />
                </Btn>
              </PermissionGate>
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

  if (loading) return <PageState title="Loading overview" />;

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

  if (isMobile) {
    const selectedApp = mobileSelection?.kind === "app" ? apps.find((app) => app.id === mobileSelection.id) : undefined;
    const selectedStack = mobileSelection?.kind === "stack" ? stacks.find((stack) => stack.id === mobileSelection.id) : undefined;
    const selectedTitle = selectedApp?.name ?? selectedStack?.name ?? "Actions";
    const selectedSubtitle = selectedApp
      ? `App · ${selectedApp.status}`
      : selectedStack
          ? `Stack · ${selectedStack.status}`
          : undefined;

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
          <button
            aria-label={`Actions for ${app.name}`}
            onClick={(event) => { event.stopPropagation(); setMobileSelection({ kind: "app", id: app.id }); }}
            className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted active:bg-subtle"
          ><MoreHorizontal size={20} /></button>
        </article>
      );
    };

    const stackCard = (stack: StackData) => {
      const memberApps = appsByStack.get(stack.id) ?? [];
      const open = expanded.has(stack.id);
      return (
        <section key={`mobile-stack-${stack.id}`} className="overflow-hidden rounded-xl border bg-surface shadow-xs">
          <div onClick={() => toggleStack(stack.id)} className="flex items-center gap-3 px-4 py-3 active:bg-subtle">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border bg-subtle text-muted"><Boxes size={18} /></span>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-medium">{stack.name}</h3>
              <div className="mt-1 flex items-center gap-2"><StatusBadge status={stack.status} /><span className="text-xs text-muted">· {memberApps.length} app{memberApps.length === 1 ? "" : "s"}</span></div>
            </div>
            <button aria-label={`Actions for ${stack.name}`} onClick={(event) => { event.stopPropagation(); setMobileSelection({ kind: "stack", id: stack.id }); }} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted active:bg-subtle"><MoreHorizontal size={20} /></button>
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

    const closeAnd = (run: () => void) => {
      setMobileSelection(null);
      run();
    };

    return (
      <main className="animate-fade-in px-4 pb-6 pt-5">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">Overview</h1>
            <p className="mt-0.5 text-sm text-muted">{apps.length} apps · {stacks.length} stacks</p>
          </div>
          <Btn onClick={load} ariaLabel="Refresh overview"><RefreshCw size={18} /></Btn>
        </div>

        {nothingDeployed ? emptyState : (
          <div className="space-y-3">
            {standaloneApps.length > 0 && (
              <div className="divide-y overflow-hidden rounded-xl border bg-surface shadow-xs">
                {standaloneApps.map((app) => appCard(app))}
              </div>
            )}
            {stacks.map(stackCard)}
          </div>
        )}

        <MobileActionSheet open={mobileSelection != null} onClose={() => setMobileSelection(null)} title={selectedTitle} subtitle={selectedSubtitle}>
          {selectedApp && (
            <>
              <MobileSheetAction icon={<Settings2 size={19} />} label="Open app" detail="Metrics, logs and deployments" primary onClick={() => closeAnd(() => { window.location.hash = `#/apps/${selectedApp.id}`; })} />
              <PermissionGate permission="apps.restart" appId={selectedApp.id} environmentId={selectedApp.environment_id}><MobileSheetAction icon={<RotateCcw size={19} />} label="Restart" loading={isAppActionLoading(selectedApp.id, "restart")} disabled={!!appBusyKind(selectedApp.id)} onClick={() => closeAnd(() => appAction("restart", selectedApp.id))} /></PermissionGate>
              <PermissionGate permission="apps.pause" appId={selectedApp.id} environmentId={selectedApp.environment_id}><MobileSheetAction icon={selectedApp.status === "paused" ? <Play size={19} /> : <Pause size={19} />} label={selectedApp.status === "paused" ? "Unpause" : "Pause"} disabled={!!appBusyKind(selectedApp.id)} onClick={() => closeAnd(() => appAction(selectedApp.status === "paused" ? "unpause" : "pause", selectedApp.id))} /></PermissionGate>
              <PermissionGate permission="apps.destroy" appId={selectedApp.id} environmentId={selectedApp.environment_id}><MobileSheetAction icon={<Trash2 size={19} />} label="Destroy app" danger disabled={!!appBusyKind(selectedApp.id)} onClick={async () => { if (await confirm("Destroy app", `Permanently destroy "${selectedApp.name}"? This removes all containers. DNS remains unchanged and must be cleaned up manually.`, true)) closeAnd(() => appAction("delete", selectedApp.id)); }} /></PermissionGate>
            </>
          )}
          {selectedStack && (
            <>
              <MobileSheetAction icon={<Settings2 size={19} />} label="Open stack" detail="Members, configuration and logs" primary onClick={() => closeAnd(() => { window.location.hash = `#/stacks/${selectedStack.id}`; })} />
              <PermissionGate permission="stacks.destroy" environmentId={selectedStack.environment_id}><MobileSheetAction icon={<Trash2 size={19} />} label="Destroy stack" danger disabled={!!stackBusyKind(selectedStack.id)} onClick={() => closeAnd(() => stackDestroy(selectedStack))} /></PermissionGate>
            </>
          )}
        </MobileActionSheet>
      </main>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Overview"
        description="Every app and stack deployed to your fleet."
        actions={<Btn onClick={load}><RefreshCw size={14} /> Refresh</Btn>}
      />

      {nothingDeployed ? emptyState : (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-line shadow-xs sm:grid-cols-4">
            {[
              { label: "Apps", value: apps.length },
              { label: "Stacks", value: stacks.length },
              { label: "Running", value: running, tone: running > 0 ? "success" as const : undefined },
              { label: attention > 0 ? "Need attention" : "Paused", value: attention > 0 ? attention : paused, tone: attention > 0 ? "danger" as const : undefined },
            ].map((stat) => (
              <Stat key={stat.label} label={stat.label} value={stat.value} tone={stat.tone} className="bg-surface px-4 py-3.5" />
            ))}
          </div>

          <Card className="overflow-hidden">
            <CardHeader
              title="Applications"
              description={`${standaloneApps.length} standalone · ${stacks.length} stack${stacks.length === 1 ? "" : "s"}`}
            />
            <div className="divide-y">
              {standaloneApps.map((app) => renderAppRow(app))}
              {stacks.map((stack) => renderStackGroup(stack, {
                apps: appsByStack.get(stack.id) ?? [],
              }))}
            </div>
          </Card>
        </>
      )}
    </PageShell>
  );
}
