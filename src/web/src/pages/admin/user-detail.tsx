import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { get, put } from "../../api/client.ts";
import { Card, CardHeader, Btn, Field, InlineNotice, showToast, Badge, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { Check, Save, Key, Lock, ShieldCheck, Target, X } from "lucide-react";
import { useAuth } from "../../stores/auth.ts";
import type { AdminUser, AppData, EnvironmentData, PermissionGrant, UserPermissionsResponse } from "../../types.ts";

// Mirrors the sections of ALL_PERMISSIONS in shared/db/users.ts. Every
// permission in that catalog appears here exactly once; the save path posts
// whatever the server sent as `allPermissions`, so a permission added there but
// missed here would still round-trip, just without a checkbox.
const PERMISSION_GROUPS: Array<{ label: string; permissions: Array<{ key: string; label: string }> }> = [
  {
    label: "Client Access",
    permissions: [
      { key: "cli.access", label: "Use the ocd CLI at all" },
    ],
  },
  {
    label: "Read",
    permissions: [
      { key: "fleet.view", label: "View servers and dashboard" },
      { key: "apps.view", label: "View apps" },
      { key: "environments.view", label: "View environments (not their values)" },
      { key: "metrics.view", label: "View replicas, metrics, replica events" },
      { key: "operations.view", label: "View engine operations" },
      { key: "deployments.view", label: "View deployment history and deploy logs" },
    ],
  },
  {
    label: "Apps",
    permissions: [
      { key: "apps.deploy", label: "Deploy apps with the CLI" },
      { key: "apps.storage.bind", label: "Deploy apps with object-storage bindings" },
      { key: "apps.notifications.bind", label: "Deploy apps with notification bindings" },
      { key: "apps.rollback", label: "Rollback deployments" },
      { key: "apps.restart", label: "Restart containers" },
      { key: "apps.pause", label: "Pause/unpause apps" },
      { key: "apps.destroy", label: "Destroy apps" },
      { key: "apps.logs", label: "View app logs" },
    ],
  },
  {
    label: "Stacks",
    permissions: [
      { key: "stacks.view", label: "View stacks" },
      { key: "stacks.deploy", label: "Deploy/redeploy stacks with the CLI" },
      { key: "stacks.destroy", label: "Destroy stacks" },
    ],
  },
  {
    label: "Environments",
    permissions: [
      { key: "environments.manage", label: "Create/edit/delete environments, attach apps" },
      { key: "environments.secrets", label: "Read/write env var values (secrets)" },
    ],
  },
  {
    label: "Placement",
    permissions: [
      { key: "scaling.migrate", label: "Move apps between servers" },
    ],
  },
  {
    label: "Servers",
    permissions: [
      { key: "servers.create", label: "Create servers" },
      { key: "servers.manage", label: "Manage servers and build workers" },
      { key: "servers.delete", label: "Delete servers" },
    ],
  },
  {
    label: "Volumes",
    permissions: [
      { key: "volumes.delete", label: "Delete volumes" },
      { key: "volumes.files.read", label: "Browse and read files on a volume" },
    ],
  },
  {
    label: "Object Storage",
    permissions: [
      { key: "buckets.create", label: "Create S3 buckets" },
      { key: "buckets.delete", label: "Delete empty S3 buckets" },
      { key: "buckets.objects.read", label: "Browse and read objects in S3 buckets" },
    ],
  },
  {
    label: "Cloud Resources",
    permissions: [
      { key: "resources.view", label: "View the resources summary" },
      { key: "resources.delete", label: "Delete orphan resources" },
    ],
  },
  {
    label: "Operations",
    permissions: [
      { key: "operations.cancel", label: "Cancel a running engine operation" },
      { key: "operations.manage", label: "Act on another user's operation (also needs operations.cancel)" },
    ],
  },
  {
    label: "Terminal",
    permissions: [
      { key: "terminal.container", label: "Shell into a container" },
      { key: "terminal.host", label: "Shell on a fleet host (root-equivalent)" },
    ],
  },
];

const grantKey = (g: PermissionGrant) => `${g.permission}|${g.scopeType}|${g.scopeId ?? ""}`;

type ScopeKind = "environment" | "app";
type ScopeKindMap = Record<string, ScopeKind[]>;

/** Human blurb for a permission key, taken from the groups above. */
function permissionLabel(key: string): string {
  for (const group of PERMISSION_GROUPS) {
    const hit = group.permissions.find((p) => p.key === key);
    if (hit) return hit.label;
  }
  return "";
}

export function UserDetailPage({ userId }: { userId: string }) {
  const auth = useAuth();
  const isSelf = auth.user?.id === userId;
  const [user, setUser] = useState<AdminUser | null>(null);
  const [grants, setGrants] = useState<PermissionGrant[]>([]);
  // Per-permission scope kinds, straight from the server's PERMISSION_SCOPES
  // (shared/db/users.ts). Absent permission => global-only, no scope button.
  const [scopeKinds, setScopeKinds] = useState<ScopeKindMap>({});
  const [apps, setApps] = useState<AppData[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentData[]>([]);
  // At most one scope modal at a time; holds the permission key.
  const [scopeOpen, setScopeOpen] = useState<string | null>(null);
  // The button that opened the modal, so focus can be handed back on close.
  const scopeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    Promise.all([
      get("/api/admin/users"),
      get(`/api/admin/users/${userId}/permissions`),
    ]).then(([usersRes, permRes]: [{ users: AdminUser[] }, UserPermissionsResponse]) => {
      setUser(usersRes.users.find((u) => u.id === userId) ?? null);
      // Older servers only send `permissions`; treat those as global grants.
      setGrants(
        permRes.grants ??
          (permRes.permissions || []).map((p) => ({ permission: p, scopeType: "global" as const, scopeId: null })),
      );
      // Older servers predate `scopeKinds`; fall back to their flat scopable
      // list, which had no per-permission kinds to offer.
      setScopeKinds(
        permRes.scopeKinds ??
          Object.fromEntries(
            (permRes.scopablePermissions || []).map((p) => [p, ["environment", "app"] as ScopeKind[]]),
          ),
      );
    }).catch((err: any) => showToast(err.message, "error")).finally(() => setLoading(false));
  }, [userId]);

  // Scope pickers; harmless to fetch even for an admin (whose grants are fixed).
  useEffect(() => {
    get("/api/apps").then(setApps).catch(() => {});
    get("/api/environments").then(setEnvironments).catch(() => {});
  }, []);

  const isGlobal = (perm: string) => grants.some((g) => g.permission === perm && g.scopeType === "global");
  const scopedOf = (perm: string) => grants.filter((g) => g.permission === perm && g.scopeType !== "global");

  const toggleGlobal = (perm: string) => {
    setGrants((prev) =>
      isGlobal(perm)
        ? prev.filter((g) => !(g.permission === perm && g.scopeType === "global"))
        : [...prev, { permission: perm, scopeType: "global", scopeId: null }],
    );
  };

  const toggleScoped = (perm: string, scopeType: "app" | "environment", scopeId: number) => {
    const target: PermissionGrant = { permission: perm, scopeType, scopeId: String(scopeId) };
    setGrants((prev) =>
      prev.some((g) => grantKey(g) === grantKey(target))
        ? prev.filter((g) => grantKey(g) !== grantKey(target))
        : [...prev, target],
    );
  };

  const removeScoped = (g: PermissionGrant) =>
    setGrants((prev) => prev.filter((x) => grantKey(x) !== grantKey(g)));

  const selectAllInGroup = (group: typeof PERMISSION_GROUPS[0]) => {
    const keys = group.permissions.map((p) => p.key);
    const allSelected = keys.every((k) => isGlobal(k));
    setGrants((prev) => {
      const withoutGroupGlobals = prev.filter(
        (g) => !(g.scopeType === "global" && keys.includes(g.permission)),
      );
      return allSelected
        ? withoutGroupGlobals
        : [
            ...withoutGroupGlobals,
            ...keys.map((k) => ({ permission: k, scopeType: "global" as const, scopeId: null })),
          ];
    });
  };

  const scopeLabel = (g: PermissionGrant): string => {
    if (g.scopeType === "app") {
      return apps.find((a) => String(a.id) === g.scopeId)?.name ?? `app#${g.scopeId}`;
    }
    return environments.find((e) => String(e.id) === g.scopeId)?.name ?? `env#${g.scopeId}`;
  };

  const saveGrants = async () => {
    setSaving(true);
    try {
      await put(`/api/admin/users/${userId}`, { grants });
      showToast("Permissions saved", "success");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    if (!newPassword || newPassword.length < 8) return showToast("Password must be at least 8 characters", "error");
    setSavingPassword(true);
    try {
      await put(`/api/admin/users/${userId}`, { password: newPassword });
      showToast("Password updated", "success");
      setNewPassword("");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading) return <PageState title="Loading user" />;
  if (!user) return <PageState kind="empty" title="User not found" action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/admin"; }}>Back to admin</Btn>} />;

  return (
    <PageShell width="md">
      <PageHeader
        backHref="#/admin"
        backLabel="Back to admin"
        eyebrow="User"
        title={user.username}
        description={user.isAdmin ? "Administrator with unrestricted access." : "Permissions and resource scopes for this user."}
        actions={user.isAdmin ? <Badge tone="warning"><ShieldCheck size={12} /> Admin</Badge> : undefined}
      />

      {/* Permissions */}
      {!user.isAdmin && (
        <Card className="overflow-hidden">
          <CardHeader
            icon={<Key size={15} />}
            title="Permissions"
            description={`${grants.length} grant${grants.length === 1 ? "" : "s"}`}
            actions={<Btn variant="primary" loading={saving} onClick={saveGrants}><Save size={14} /> Save</Btn>}
          />
          <p className="border-b px-4 py-3 text-sm text-fg-dim">
            Tick a permission to grant it fleet-wide. For the ones marked scopable, use
            <span className="font-medium text-fg"> Scope </span>
            to grant it on individual apps or environments instead — a fleet-wide tick supersedes those.
          </p>
          {PERMISSION_GROUPS.map((group) => {
            const allSelected = group.permissions.every((p) => isGlobal(p.key));
            const grantedCount = group.permissions.filter((p) => isGlobal(p.key)).length;
            return (
              <section key={group.label} className="border-b last:border-b-0">
                <div className="flex items-center justify-between gap-3 border-b bg-subtle/50 px-4 py-1.5">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-medium text-fg-dim">{group.label}</h4>
                    <span className="text-xs tabular-nums text-muted">{grantedCount}/{group.permissions.length}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => selectAllInGroup(group)}
                    className="rounded px-1.5 py-0.5 text-xs font-medium text-muted transition-colors hover:bg-subtle hover:text-fg"
                  >
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="divide-y">
                  {group.permissions.map((perm) => {
                    const checked = isGlobal(perm.key);
                    const scoped = scopedOf(perm.key);
                    const kinds = scopeKinds[perm.key] ?? [];
                    const open = scopeOpen === perm.key;
                    return (
                      <div key={perm.key} className="px-4 py-2.5 transition-colors hover:bg-subtle/40">
                        <div className="flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleGlobal(perm.key)}
                            className="flex-shrink-0"
                            id={`perm-${perm.key}`}
                          />
                          <label htmlFor={`perm-${perm.key}`} className="min-w-0 flex-1 cursor-pointer">
                            <span className={`block text-sm ${checked ? "font-medium text-fg" : "text-fg-dim"}`}>{perm.label}</span>
                            <span className="block font-mono text-xs text-muted">{perm.key}</span>
                          </label>
                          {/* Only permissions the server reports as scopable
                              get an affordance at all; the modal keeps the
                              row's height fixed however many scopes exist. */}
                          {kinds.length > 0 && (
                            <button
                              type="button"
                              onClick={(e) => {
                                scopeTriggerRef.current = e.currentTarget;
                                setScopeOpen(perm.key);
                              }}
                              title="Grant on individual apps or environments"
                              aria-haspopup="dialog"
                              aria-expanded={open}
                              className={`inline-flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors ${
                                scoped.length > 0 ? "border-info/25 bg-info/10 text-info hover:bg-info/15" : "border-line-strong bg-surface text-fg-dim hover:bg-subtle hover:text-fg"
                              }`}
                            >
                              <Target size={12} />
                              {scoped.length > 0 ? `Scoped · ${scoped.length}` : "Scope"}
                            </button>
                          )}
                        </div>

                        {/* Existing narrower grants. A global tick makes them
                            redundant, so they are struck through rather than
                            silently dropped — untick global and they apply again. */}
                        {scoped.length > 0 && (
                          <div className="mt-2 pl-7">
                            <ScopeChips
                              grants={scoped}
                              superseded={checked}
                              label={scopeLabel}
                              onRemove={removeScoped}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </Card>
      )}

      {scopeOpen && (
        <ScopeModal
          permission={scopeOpen}
          description={permissionLabel(scopeOpen)}
          kinds={scopeKinds[scopeOpen] ?? []}
          isGlobal={isGlobal(scopeOpen)}
          scoped={scopedOf(scopeOpen)}
          apps={apps}
          environments={environments}
          scopeLabel={scopeLabel}
          onToggle={(kind, id) => toggleScoped(scopeOpen, kind, id)}
          onRemove={removeScoped}
          onClose={() => {
            setScopeOpen(null);
            scopeTriggerRef.current?.focus();
            scopeTriggerRef.current = null;
          }}
        />
      )}

      {/* Reset Password — hidden when viewing yourself; use the change-password card on the user list page instead. */}
      {!isSelf && (
        <Card className="overflow-hidden">
          <CardHeader icon={<Lock size={15} />} title="Reset password" description={`Set a new password for ${user.username}.`} />
          <div className="px-4">
            <Field label="New password">
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min 8 chars)" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 border-t bg-subtle/40 px-4 py-3">
            <Btn variant="default" loading={savingPassword} onClick={resetPassword}>Update password</Btn>
          </div>
        </Card>
      )}
    </PageShell>
  );
}

/** Existing narrower grants. A global tick makes them redundant, so they are
 *  struck through rather than silently dropped — untick global and they apply
 *  again. Rendered both on the row and inside the modal. */
function ScopeChips({ grants, superseded, label, onRemove }: {
  grants: PermissionGrant[];
  superseded: boolean;
  label: (g: PermissionGrant) => string;
  onRemove: (g: PermissionGrant) => void;
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${superseded ? "opacity-50" : ""}`}>
      {grants.map((g) => (
        <span
          key={grantKey(g)}
          className={`inline-flex h-6 items-center gap-1 rounded-md border bg-subtle pl-2 pr-0.5 text-xs text-fg ${superseded ? "line-through" : ""}`}
          title={superseded ? "Superseded by the fleet-wide grant" : undefined}
        >
          <span className="text-muted">{g.scopeType === "app" ? "app" : "env"}</span>
          <span className="font-mono">{label(g)}</span>
          <button type="button" onClick={() => onRemove(g)} aria-label={`Remove ${label(g)}`} className="grid h-5 w-5 place-items-center rounded text-muted transition-colors hover:bg-danger/10 hover:text-danger">
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Scope picker, portalled to <body> so opening it never resizes the
 *  permission row it belongs to. Only the scope kinds the server says are
 *  meaningful for this permission get a section. */
function ScopeModal({
  permission, description, kinds, isGlobal, scoped, apps, environments, scopeLabel, onToggle, onRemove, onClose,
}: {
  permission: string;
  description: string;
  kinds: ScopeKind[];
  isGlobal: boolean;
  scoped: PermissionGrant[];
  apps: AppData[];
  environments: EnvironmentData[];
  scopeLabel: (g: PermissionGrant) => string;
  onToggle: (kind: ScopeKind, id: number) => void;
  onRemove: (g: PermissionGrant) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // Background must not scroll underneath the dialog.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex animate-fade-in items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Scope ${permission}`}
        className="flex max-h-[80vh] w-full max-w-lg animate-pop-in flex-col overflow-hidden rounded-xl border bg-surface shadow-pop"
      >
        <div className="flex items-start gap-3 border-b px-5 py-4">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted"><Target size={15} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="break-all font-mono text-sm font-medium text-fg">{permission}</h3>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {isGlobal && (
            <InlineNotice tone="info">Granted fleet-wide; scopes below are ignored until you untick it.</InlineNotice>
          )}
          {kinds.includes("environment") && (
            <ScopeList
              title="Environments"
              items={environments.map((e) => ({ id: e.id, name: e.name }))}
              selected={scoped.filter((g) => g.scopeType === "environment").map((g) => g.scopeId)}
              onToggle={(id) => onToggle("environment", id)}
            />
          )}
          {kinds.includes("app") && (
            <ScopeList
              title="Apps"
              items={apps.map((a) => ({ id: a.id, name: a.name }))}
              selected={scoped.filter((g) => g.scopeType === "app").map((g) => g.scopeId)}
              onToggle={(id) => onToggle("app", id)}
            />
          )}
          {scoped.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted">Granted on</div>
              <ScopeChips grants={scoped} superseded={isGlobal} label={scopeLabel} onRemove={onRemove} />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t bg-subtle/50 px-5 py-3">
          <Btn variant="primary" onClick={onClose}>Done</Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ScopeList({ title, items, selected, onToggle }: {
  title: string;
  items: Array<{ id: number; name: string }>;
  selected: Array<string | null>;
  onToggle: (id: number) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted">{title}</div>
      {items.length === 0 ? (
        <div className="text-sm text-muted">None</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => {
            const on = selected.includes(String(it.id));
            return (
              <button
                key={it.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(it.id)}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 font-mono text-xs transition-colors ${
                  on ? "border-primary bg-primary text-primary-fg" : "border-line-strong bg-surface text-fg-dim hover:bg-subtle hover:text-fg"
                }`}
              >
                {on && <Check size={12} />}
                {it.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
