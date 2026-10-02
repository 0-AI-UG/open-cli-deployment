import { useState, useEffect } from "react";
import { get, post, put, del } from "../../api/client.ts";
import { Card, CardHeader, Btn, Field, EmptyState, SkeletonCard, showToast, confirm } from "../../components/ui.tsx";
import { useAuth } from "../../stores/auth.ts";
import { Users, Plus, Trash2, Lock, ShieldAlert, Fingerprint } from "lucide-react";

const FORM_FOOTER = "flex flex-wrap justify-end gap-2 border-t bg-subtle/40 px-4 py-3";

const initials = (name: string) => {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
};

type User = { id: string; username: string; webauthnEnabled: boolean; createdAt: string };

export function UsersSettings() {
  const auth = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", password: "" });
  const [require2fa, setRequire2fa] = useState(true);
  const [savingRequire2fa, setSavingRequire2fa] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const loadUsers = async () => {
    try {
      const res = await get("/api/users");
      setUsers(res.users);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
    get("/api/settings").then((s) => setRequire2fa(s.require_2fa !== false)).catch(() => {});
  }, []);

  const toggleRequire2fa = async (next: boolean) => {
    setSavingRequire2fa(true);
    setRequire2fa(next);
    try {
      await put("/api/settings", { require_2fa: next });
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
      await post("/api/users", form);
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
      await del(`/api/users/${user.id}`);
      showToast("User deleted", "success");
      loadUsers();
    } catch (err: any) {
      showToast(err.message, "error");
    }
  };

  const handleResetPassword = async (e: React.FormEvent, user: User) => {
    e.preventDefault();
    if (newPassword.length < 8) return showToast("Password must be at least 8 characters", "error");
    setSavingPassword(true);
    try {
      await put(`/api/users/${user.id}`, { password: newPassword });
      showToast(`Password updated for ${user.username}`, "success");
      setResetting(null);
      setNewPassword("");
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSavingPassword(false);
    }
  };

  if (loading) return <SkeletonCard rows={3} label="Loading users" />;

  return (
    <Card className="overflow-hidden">
        <CardHeader
          icon={<Users size={15} />}
          title="Users"
          description={`${users.length} user${users.length === 1 ? "" : "s"}`}
          actions={<Btn variant={showCreate ? "default" : "primary"} onClick={() => setShowCreate(!showCreate)}><Plus size={14} /> Invite user</Btn>}
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
              <Btn type="submit" variant="primary" loading={creating}>Invite</Btn>
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
          {users.map((u) => {
            const isSelf = auth.user?.id === u.id;
            return (
              <div key={u.id}>
                <div className="flex min-h-14 items-center gap-3 px-4 py-2.5 max-md:min-h-16">
                  <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-full border bg-subtle text-xs font-semibold text-fg-dim">
                    {initials(u.username)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{u.username}{isSelf && <span className="ml-1.5 text-xs font-normal text-muted">(you)</span>}</span>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      <span className="tabular-nums">Created {new Date(u.createdAt + "Z").toLocaleDateString()}</span>
                      <span className="sm:hidden">· {u.webauthnEnabled ? "Passkey" : "No 2FA"}</span>
                    </div>
                  </div>
                  <div className="hidden w-24 shrink-0 sm:block">
                    {u.webauthnEnabled
                      ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-dim"><Fingerprint size={13} className="text-success" /> Passkey</span>
                      : <span className="text-xs text-muted">No 2FA</span>}
                  </div>
                  {!isSelf && (
                    <div className="flex shrink-0 justify-end gap-1">
                      <Btn size="xs" variant="ghost" title={`Reset password for ${u.username}`} onClick={() => { setResetting(resetting === u.id ? null : u.id); setNewPassword(""); }}>
                        <Lock size={14} />
                      </Btn>
                      <Btn size="xs" variant="ghost" title={`Delete ${u.username}`} onClick={() => handleDelete(u)}>
                        <Trash2 size={14} />
                      </Btn>
                    </div>
                  )}
                </div>
                {resetting === u.id && (
                  <form onSubmit={(e) => handleResetPassword(e, u)} className="animate-slide-up border-t bg-canvas/40">
                    <div className="px-4">
                      <Field label={`New password for ${u.username}`}>
                        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Min 8 characters" required autoFocus />
                      </Field>
                    </div>
                    <div className={FORM_FOOTER}>
                      <Btn onClick={() => setResetting(null)}>Cancel</Btn>
                      <Btn type="submit" variant="primary" loading={savingPassword}>Update password</Btn>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>}
    </Card>
  );
}
