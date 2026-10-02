import { useState, useEffect } from "react";
import { get, put } from "../../api/client.ts";
import { Card, CardHeader, Btn, Field, showToast, Badge, PageShell, PageHeader, PageState } from "../../components/ui.tsx";
import { Save, Key, Lock, ShieldCheck } from "lucide-react";
import { useAuth } from "../../stores/auth.ts";
import type { AdminUser, UserPermissionsResponse } from "../../types.ts";

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

export function UserDetailPage({ userId }: { userId: string }) {
  const auth = useAuth();
  const isSelf = auth.user?.id === userId;
  const [user, setUser] = useState<AdminUser | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]);
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
      setPermissions(permRes.permissions);
    }).catch((err: any) => showToast(err.message, "error")).finally(() => setLoading(false));
  }, [userId]);

  const toggle = (perm: string) =>
    setPermissions((prev) => prev.includes(perm) ? prev.filter((p) => p !== perm) : [...prev, perm]);

  const toggleGroup = (keys: string[]) =>
    setPermissions((prev) => keys.every((k) => prev.includes(k))
      ? prev.filter((p) => !keys.includes(p))
      : [...new Set([...prev, ...keys])]);

  const savePermissions = async () => {
    setSaving(true);
    try {
      await put(`/api/admin/users/${userId}`, { permissions });
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

  if (loading) return <PageState title="Loading user" width="md" />;
  if (!user) return <PageState kind="empty" width="md" title="User not found" action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/admin"; }}>Back to settings</Btn>} />;

  return (
    <PageShell width="md">
      <PageHeader
        backHref="#/admin"
        backLabel="Back to settings"
        eyebrow="User"
        title={user.username}
        description={user.isAdmin ? "Administrator with unrestricted access." : "Fleet-wide permissions for this user."}
        actions={user.isAdmin ? <Badge tone="warning"><ShieldCheck size={12} /> Admin</Badge> : undefined}
      />

      {!user.isAdmin && (
        <Card className="overflow-hidden">
          <CardHeader
            icon={<Key size={15} />}
            title="Permissions"
            description={`${permissions.length} granted`}
            actions={<Btn variant="primary" loading={saving} onClick={savePermissions}><Save size={14} /> Save</Btn>}
          />
          {PERMISSION_GROUPS.map((group) => {
            const keys = group.permissions.map((p) => p.key);
            const grantedCount = keys.filter((k) => permissions.includes(k)).length;
            return (
              <section key={group.label} className="border-b last:border-b-0">
                <div className="flex items-center justify-between gap-3 border-b bg-subtle/50 px-4 py-1.5">
                  <div className="flex items-center gap-2">
                    <h4 className="text-xs font-medium text-fg-dim">{group.label}</h4>
                    <span className="text-xs tabular-nums text-muted">{grantedCount}/{keys.length}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleGroup(keys)}
                    className="rounded px-1.5 py-0.5 text-xs font-medium text-muted transition-colors hover:bg-subtle hover:text-fg"
                  >
                    {grantedCount === keys.length ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="divide-y">
                  {group.permissions.map((perm) => {
                    const checked = permissions.includes(perm.key);
                    return (
                      <label key={perm.key} className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-subtle/40">
                        <input type="checkbox" checked={checked} onChange={() => toggle(perm.key)} className="flex-shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-sm ${checked ? "font-medium text-fg" : "text-fg-dim"}`}>{perm.label}</span>
                          <span className="block font-mono text-xs text-muted">{perm.key}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </Card>
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
