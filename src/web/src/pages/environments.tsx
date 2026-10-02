import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";
import { Card, CardHeader, Btn, Field, showToast, confirm, confirmWithText, EmptyState, PageShell, PageHeader } from "../components/ui.tsx";
import { EnvVarEditor, type EnvVarRow } from "../components/env-var-editor.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { NeoSelect } from "../components/neo-select.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { Layers, Plus, Trash2, Copy, ChevronDown, ChevronRight, Key, RotateCcw } from "lucide-react";
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
  const [attachedApps, setAttachedApps] = useState<Record<number, AttachedApp[]>>({});
  // Inline "copy an environment" bar (source picker + new-name input), opened
  // from the header Copy button. null = closed.
  const [copy, setCopy] = useState<{ sourceId: number | null; name: string } | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const copyPopoverRef = useRef<HTMLDivElement>(null);

  // Close the copy popover on an outside click — but ignore clicks in the
  // NeoSelect menu, which is portaled to document.body (outside the ref).
  useEffect(() => {
    if (!copy) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (copyPopoverRef.current && !copyPopoverRef.current.contains(target) && !target.closest("[data-neoselect-menu]")) {
        setCopy(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [copy]);

  const ops = useActiveOperations(
    (op) => op.kind === "cascade_redeploy",
    { rehydrateToasts: true },
  );

  const load = () => {
    get("/api/environments").then(setEnvironments).catch(() => {});
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
      const rows = editVars.filter((e) => e.key.trim());
      const vars = rows.filter((entry) => !entry.secret).map((entry) => `${entry.key.trim()}=${entry.value}`);
      const secretVars = rows.filter((entry) => entry.secret).map((entry) => `${entry.key.trim()}=${entry.value}`);
      if (id === "new") {
        await runCliAction("envs.create", { name: editName, vars, secretVars });
        showToast("Environment created", "success");
      } else {
        const apps = attachedApps[id] || [];
        const activeApps = apps.filter((a) => a.status !== "stopped" && a.status !== "destroying");
        if (activeApps.length > 0 && rollout !== "none") {
          const ok = await confirm(
            "Reload Apps",
            `Saving will recreate ${activeApps.length} app(s) from their existing immutable images: ${activeApps.map((a) => a.name).join(", ")}`,
            true,
          );
          if (!ok) { setLoading(false); return; }
        }
        const existing = environments.find((environment) => environment.id === id);
        if (existing && existing.name !== editName.trim()) {
          await runCliAction("envs.rename", {
            environment: String(id),
            newName: editName.trim(),
          });
        }
        if (rows.length > 0) {
          await runCliAction("envs.set", {
            environment: String(id),
            vars,
            secretVars,
            replace: true,
            rollout,
          });
        } else if ((existing?.env_vars.length ?? 0) > 0) {
          await runCliAction("envs.unset", {
            environment: String(id),
            keys: existing!.env_vars.map((entry) => entry.key),
            rollout,
          });
        } else {
          showToast("Environment updated", "success");
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

  const startCopy = () => {
    setExpanded(null);
    const src = environments[0] ?? null;
    setCopy({ sourceId: src?.id ?? null, name: src ? `${src.name}-copy` : "" });
  };

  // When the source changes, pre-fill the name with "<source>-copy" unless the
  // user has already typed a custom name.
  const pickCopySource = (id: number | null) => {
    setCopy((c) => {
      if (!c) return c;
      const src = environments.find((e) => e.id === id);
      const prevSrc = environments.find((e) => e.id === c.sourceId);
      const untouched = c.name === "" || c.name === (prevSrc ? `${prevSrc.name}-copy` : "");
      return { sourceId: id, name: untouched && src ? `${src.name}-copy` : c.name };
    });
  };

  const doCopy = async () => {
    if (!copy?.sourceId || !copy.name.trim()) return;
    setCopyBusy(true);
    try {
      await runCliAction("envs.copy", {
        environment: String(copy.sourceId),
        newName: copy.name.trim(),
      });
      showToast("Environment duplicated", "success");
      setCopy(null);
      load();
    } catch (err: any) {
      showToast(err.message || "Failed to duplicate", "error");
    } finally {
      setCopyBusy(false);
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
          {/* Env var values are credentials, so they sit behind their own grant
              rather than the environment lifecycle one. */}
          <PermissionGate
            permission="environments.secrets"
            environmentId={typeof id === "number" ? id : undefined}
            fallback={
              <p className="text-sm text-muted">
                Env vars hidden — requires <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">environments.secrets</code>
              </p>
            }
          >
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
          </PermissionGate>
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
          {environments.length > 0 && (
            <div className="relative" ref={copyPopoverRef}>
              <Btn onClick={() => (copy ? setCopy(null) : startCopy())}>
                <Copy size={14} /> Copy
              </Btn>
              {copy && (
                <div className="absolute right-0 top-full z-50 mt-2 w-72 bg-surface rounded-lg shadow-pop">
                  <div className="border-b px-3 py-2.5">
                    <div className="text-sm font-semibold text-fg">Duplicate environment</div>
                    <p className="text-xs text-muted">Copies every variable into a new environment.</p>
                  </div>
                  <div className="space-y-2 p-3">
                    <NeoSelect
                      compact
                      value={copy.sourceId != null ? String(copy.sourceId) : ""}
                      placeholder="Environment to copy"
                      options={environments.map((e) => ({ value: String(e.id), label: e.name }))}
                      onChange={(v) => pickCopySource(v ? parseInt(v) : null)}
                    />
                    <input
                      type="text"
                      value={copy.name}
                      onChange={(e) => setCopy((c) => (c ? { ...c, name: e.target.value } : c))}
                      onKeyDown={(e) => { if (e.key === "Enter") doCopy(); if (e.key === "Escape") setCopy(null); }}
                      placeholder="New environment name"
                      className="w-full"
                      autoFocus
                    />
                  </div>
                  <div className="flex justify-end gap-2 border-t bg-subtle/40 px-3 py-2.5">
                    <Btn size="xs" variant="ghost" onClick={() => setCopy(null)}>Cancel</Btn>
                    <Btn size="xs" variant="primary" loading={copyBusy} disabled={!copy.sourceId || !copy.name.trim() || copyBusy} onClick={doCopy}>
                      Duplicate
                    </Btn>
                  </div>
                </div>
              )}
            </div>
          )}
          <Btn variant="primary" onClick={startNew}>
            <Plus size={14} /> New
          </Btn>
        </>}
      />

      {environments.length > 0 || expanded === "new" ? (
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
                      <Btn
                        variant="ghost"
                        title="Delete"
                        onClick={async () => {
                          if (apps.length > 0) {
                            showToast(`Cannot delete: used by ${apps.map((a) => a.name).join(", ")}`, "error");
                            return;
                          }
                          if (await confirm("Delete Environment", `Delete "${env.name}"?`, true)) {
                            try {
                              await runConfirmedCliAction(
                                "envs.delete",
                                { environment: String(env.id) },
                                { action: "delete_environment", resourceType: "environment", resourceId: env.id },
                              );
                              showToast("Environment retained for recovery", "success");
                              load();
                            } catch (err: any) {
                              showToast(err.message || "Failed to delete", "error");
                            }
                          }
                        }}
                      >
                        <Trash2 size={15} />
                      </Btn>
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
            description="Recoverable configuration retained separately from apps and stacks."
          />
          <div className="divide-y">
            {deletedEnvironments.map((environment) => (
              <div key={environment.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">{environment.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    Recovery-protected until {environment.purge_after || "the recovery window ends"}. Purge here can override protection.
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Btn
                    size="xs"
                    title="Restore environment"
                    onClick={async () => {
                      try {
                        await runCliAction("envs.restore", { environment: String(environment.id) });
                        showToast("Environment restored", "success");
                        load();
                      } catch (err: any) {
                        showToast(err.message || "Failed to restore", "error");
                      }
                    }}
                  >
                    <RotateCcw size={13} /> Restore
                  </Btn>
                  <Btn
                    size="xs"
                    variant="ghost"
                    onClick={async () => {
                      if (!await confirmWithText(
                        "Permanently Delete Environment",
                        `Permanently delete "${environment.name}" and all its variables? This cannot be undone.`,
                        environment.name,
                        `Type ${environment.name} to confirm`,
                      )) return;
                      try {
                        await runConfirmedCliAction(
                          "envs.purge",
                          { environment: String(environment.id) },
                          {
                            action: "purge_environment",
                            resourceType: "environment",
                            resourceId: environment.id,
                            typedResource: environment.name,
                          },
                        );
                        showToast("Environment permanently deleted", "success");
                        load();
                      } catch (err: any) {
                        showToast(err.message || "Failed to purge", "error");
                      }
                    }}
                  >
                    <Trash2 size={13} className="text-danger" /> Purge
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </PageShell>
  );
}
