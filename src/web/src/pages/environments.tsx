import { useState, useEffect } from "react";
import { get, post, put } from "../api/client.ts";
import { Card, CardHeader, Btn, Field, showToast, confirm, EmptyState, PageShell, PageHeader, SkeletonCard } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { trackOperationInToast, useActiveOperations } from "../hooks/useOperation.ts";
import { NeoSelect } from "../components/neo-select.tsx";
import { Layers, Plus, Trash2, ChevronDown, ChevronRight, Key } from "lucide-react";
import type { EnvironmentData } from "../types.ts";

type AttachedApp = { id: number; name: string; status: string; domain: string; runtime_env_vars?: EnvVarRow[] };
export function EnvironmentsPage() {
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  const [deletedEnvironments, setDeletedEnvironments] = useState<EnvironmentData[]>([]);
  const [expanded, setExpanded] = useState<number | "new" | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<EnvVarRow[]>([]);
  const [rollout, setRollout] = useState<"restart" | "none">("restart");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attachedApps, setAttachedApps] = useState<Record<number, AttachedApp[]>>({});
  const ops = useActiveOperations(
    (op) => op.kind === "cascade_redeploy",
    { rehydrateToasts: true },
  );

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {}).finally(() => setLoaded(true));
    get("/api/environments/deleted").then(setDeletedEnvironments).catch(() => {});
  };

  useEffect(load, []);

  // Load attached apps for all environments
  useEffect(() => {
    for (const env of environments) {
      get(`/api/environments/${env.id}/apps`)
        .then((apps: AttachedApp[]) => {
          setAttachedApps((prev) => ({ ...prev, [env.id]: apps }));
        })
        .catch(() => {});
    }
  }, [environments]);

  const toggle = (env: EnvironmentData) => {
    if (expanded === env.id) {
      setExpanded(null);
    } else {
      setExpanded(env.id);
      setEditName(env.name);
      setEditVars(env.env_vars.map((e) => ({ key: e.key, value: e.value, secret: e.secret, injected_by: e.injected_by })));
      setRollout("restart");
    }
  };

  const startNew = () => {
    setExpanded("new");
    setEditName("");
    setEditVars([]);
    setRollout("restart");
  };

  const save = async (id: number | "new") => {
    setLoading(true);
    try {
      const env_vars = editVars
        .filter((entry) => entry.key.trim())
        .map((entry) => ({ key: entry.key.trim(), value: entry.value, secret: entry.secret }));
      if (id === "new") {
        await post("/api/environments", { name: editName.trim(), env_vars });
        showToast("Environment created", "success");
      } else {
        const apps = attachedApps[id] || [];
        const activeApps = apps.filter((a) => a.status !== "stopped" && a.status !== "destroying");
        if (activeApps.length > 0 && rollout !== "none") {
          const ok = await confirm(
            "Reload Apps",
            `Changed variables will recreate affected apps from their existing immutable images: ${activeApps.map((a) => a.name).join(", ")}`,
            true,
          );
          if (!ok) { setLoading(false); return; }
        }
        // The server handles rename, treats omitted keys as unset, and keeps
        // masked secret values unchanged.
        const result = await put(`/api/environments/${id}`, {
          name: editName.trim(),
          env_vars, rollout,
        }) as { op_id?: number | null };
        if (result?.op_id) {
          trackOperationInToast(result.op_id, "Roll out environment");
          ops.track(result.op_id);
        }
        showToast("Environment updated", "success");
      }
      setExpanded(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to save", "error");
    } finally {
      setLoading(false);
    }
  };

  const renderEditor = (id: number | "new") => {
    const envBusy = typeof id === "number" && !!ops.byResourceKey(`env:${id}`);
    return (
      <>
        <div className="px-4">
          <Field label="Name">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Environment name"
              className="w-full"
              autoFocus
            />
          </Field>
        </div>
        <div className="space-y-3 border-t px-4 py-4">
          <div className="text-sm font-medium text-fg">Variables</div>
            <EnvVarEditor entries={editVars} onChange={setEditVars} />
            {typeof id === "number" && (attachedApps[id] || []).map((app) => (
              <details key={app.id} className="group mt-3 frame bg-surface">
                <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-xs text-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={13} className="shrink-0 transition-transform group-open:rotate-90" />
                  Injected at runtime · <span className="font-medium text-fg-dim">{app.name}</span>
                </summary>
                <div className="space-y-2 border-t px-3 py-3">
                  <p className="text-xs text-muted">Provided per app by OCD. These values are not stored in this shared environment.</p>
                  <EnvVarEditor entries={app.runtime_env_vars || []} onChange={() => {}} readOnly />
                </div>
              </details>
            ))}
        </div>
        {typeof id === "number" && (
          <div className="border-t px-4">
            <Field label="Apply changes" hint="Reloading recreates attached apps from their existing images.">
              <NeoSelect
                compact
                value={rollout}
                options={[
                  { value: "restart", label: "Reload running apps now" },
                  { value: "none", label: "Apply on next deploy" },
                ]}
                onChange={(value) => setRollout((value || "restart") as typeof rollout)}
              />
            </Field>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t bg-subtle/40 px-4 py-3">
          <Btn variant="ghost" onClick={() => setExpanded(null)}>Cancel</Btn>
          <Btn variant="primary" loading={loading || envBusy} disabled={!editName.trim() || envBusy} onClick={() => save(id)}>
            {id === "new" ? "Create" : envBusy ? "Rolling out…" : "Save"}
          </Btn>
        </div>
      </>
    );
  };

  return (
    <PageShell>
      <PageHeader
        title="Environments"
        description="Reusable variables and secrets projected into app deployments."
        actions={<>
          <Btn variant="primary" onClick={startNew}>
            <Plus size={14} /> New
          </Btn>
        </>}
      />

      {!loaded ? (
        <SkeletonCard rows={3} label="Loading environments" />
      ) : environments.length > 0 || expanded === "new" ? (
        <Card className="overflow-hidden">
          <CardHeader
            title="Environments"
            icon={<Layers size={15} />}
            description={`${environments.length} environment${environments.length === 1 ? "" : "s"}`}
          />
          <div className="divide-y">
            {expanded === "new" && (
              <div>
                <div className="flex items-center gap-3 bg-subtle/40 py-3 pl-4 pr-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-surface text-muted">
                    <Plus size={15} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-fg">New environment</div>
                    <div className="mt-0.5 text-xs text-muted">Name it and add its variables.</div>
                  </div>
                </div>
                <div className="border-t bg-canvas/50">
                  {renderEditor("new")}
                </div>
              </div>
            )}
            {environments.map((env) => {
              const isOpen = expanded === env.id;
              const apps = attachedApps[env.id] || [];
              return (
                <div key={env.id}>
                  <div
                    className={`flex cursor-pointer items-center justify-between gap-3 py-3 pl-4 pr-3 transition-colors hover:bg-subtle/50 ${isOpen ? "bg-subtle/40" : ""}`}
                    onClick={() => toggle(env)}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">
                        <Layers size={15} />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-fg">{env.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <Key size={11} /> {env.env_vars.length} variable{env.env_vars.length !== 1 ? "s" : ""}
                          </span>
                          {apps.length > 0 && (
                            <span className="tabular-nums">· {apps.length} app{apps.length !== 1 ? "s" : ""}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                      <Btn variant="ghost" title={isOpen ? "Collapse" : "Expand"} onClick={() => toggle(env)}>
                        <ChevronDown size={15} className={`transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                      </Btn>
                    </div>
                  </div>
                  {isOpen && (
                    <div className="border-t bg-canvas/50">
                      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-3">
                        <span className="mr-1 text-xs text-muted">Used by</span>
                        {apps.map((a) => (
                          <a
                            key={a.id}
                            href={`#/apps/${a.id}`}
                            className="inline-flex h-6 items-center rounded-md border bg-surface px-2 text-xs font-medium text-fg-dim transition-colors hover:bg-subtle hover:text-fg"
                          >
                            {a.name}
                          </a>
                        ))}
                        {apps.length === 0 && <span className="text-xs text-muted">No apps</span>}
                      </div>
                      {renderEditor(env.id)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      ) : (
        <Card>
          <EmptyState
            message="No environments yet"
            icon={Layers}
            description="Create one to share variables and secrets across apps."
            action={<Btn variant="primary" onClick={startNew}><Plus size={14} /> New environment</Btn>}
          />
        </Card>
      )}

      {deletedEnvironments.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader
            title="Deleted environments"
            icon={<Trash2 size={15} />}
            description={<>Recoverable configuration. Restore with <code className="font-mono">ocd envs restore</code>.</>}
          />
          <div className="divide-y">
            {deletedEnvironments.map((environment) => (
              <div key={environment.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">{environment.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Recovery-protected until {environment.purge_after || "the recovery window ends"}.
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </PageShell>
  );
}
