import { UserNtfySettings } from "../components/ntfy-settings.tsx";
import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { Badge, Card, CardHeader, Btn, Spinner, showToast, PageShell, PageHeader } from "../components/ui.tsx";
import { User, Shield, Fingerprint, Trash2, LogOut, GitBranch, LinkIcon, Unlink, Plus } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { logout, useAuth, updateUser } from "../stores/auth.ts";

type PasskeyInfo = { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string };

function SecuritySection() {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const supportsWebAuthn = browserSupportsWebAuthn();

  const refresh = () => {
    get("/api/auth/webauthn/credentials")
      .then(setPasskeys)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const addPasskey = async () => {
    setBusy(true);
    try {
      const options = await post("/api/auth/webauthn/register-options");
      const credential = await startRegistration({ optionsJSON: options });
      await post("/api/auth/webauthn/register-verify", { credential });
      showToast("Passkey added", "success");
      refresh();
    } catch (err: any) {
      if (err.name !== "NotAllowedError") {
        showToast(err.message || "Failed to add passkey", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const deletePasskey = async (id: string, name: string) => {
    if (!confirm(`Remove passkey "${name}"?`)) return;
    setBusy(true);
    try {
      await post("/api/auth/webauthn/delete", { credentialId: id });
      showToast("Passkey removed", "success");
      refresh();
    } catch (err: any) {
      showToast(err.message || "Failed to remove passkey", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="flex justify-center p-6"><Spinner /></Card>;

  return (
    <Card className="overflow-hidden">
      <CardHeader icon={<Shield size={15} />} title="Security" description="Passkeys and password sign-in" />

      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">Passkeys</div>
          <p className="text-xs text-muted">
            {supportsWebAuthn ? "Used for two-factor sign-in and password resets." : "Your browser does not support passkeys."}
          </p>
        </div>
        {supportsWebAuthn && (
          <Btn loading={busy} onClick={addPasskey}>
            <Plus size={14} /> Add passkey
          </Btn>
        )}
      </div>
      {passkeys.length === 0 ? (
        <div className="border-t px-4 py-3 text-sm text-muted">No passkeys registered.</div>
      ) : (
        <div className="divide-y border-t">
          {passkeys.map((pk) => {
            const kind = pk.backedUp ? "Synced" : pk.deviceType === "singleDevice" ? "Device-bound" : "";
            return (
              <div key={pk.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-subtle/50">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted">
                  <Fingerprint size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{pk.name}</span>
                    {kind && <Badge>{kind}</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    Added {new Date(pk.createdAt + "Z").toLocaleDateString()}
                  </div>
                </div>
                <Btn
                  variant="ghost"
                  disabled={busy}
                  title="Remove passkey"
                  onClick={() => deletePasskey(pk.id, pk.name)}
                >
                  <Trash2 size={14} />
                </Btn>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-4 border-t px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg">Password</div>
          <p className="text-xs text-muted">You will be signed out and redirected to the password reset page.</p>
        </div>
        <Btn onClick={() => { logout(); window.location.hash = "#/password-reset"; }}>
          <LogOut size={14} /> Change password
        </Btn>
      </div>
    </Card>
  );
}

function GitHubSection() {
  const { user } = useAuth();
  const [status, setStatus] = useState<{ linked: boolean; githubUsername: string; avatarUrl: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    get("/api/auth/github/status")
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // Check for OAuth callback result in URL
    const params = new URLSearchParams(window.location.hash.split("?")[1] || "");
    if (params.get("github") === "linked") {
      showToast("GitHub account linked", "success");
      // Refresh user data so the auth store is up to date
      get("/api/me").then((data: { user?: Parameters<typeof updateUser>[0] }) => { if (data.user) updateUser(data.user); }).catch(() => {});
      // Clean URL
      window.location.hash = "#/account";
    } else if (params.get("github") === "error") {
      const reason = params.get("reason") || "unknown";
      const messages: Record<string, string> = {
        missing_params: "GitHub did not return the expected parameters",
        invalid_state: "Session expired. Please try again.",
        not_configured: "GitHub OAuth is not configured by the admin",
        token_exchange: "Failed to exchange code with GitHub",
        user_fetch: "Failed to fetch your GitHub profile",
        internal: "An internal error occurred",
      };
      showToast(messages[reason] || "Failed to link GitHub", "error");
      window.location.hash = "#/account";
    }
  }, []);

  const linkGitHub = async () => {
    setBusy(true);
    try {
      const { url } = await get("/api/auth/github/authorize") as { url: string };
      window.location.href = url;
    } catch (err: any) {
      showToast(err.message || "Failed to start GitHub OAuth", "error");
      setBusy(false);
    }
  };

  const unlinkGitHub = async () => {
    setBusy(true);
    try {
      await post("/api/auth/github/unlink");
      showToast("GitHub account unlinked", "success");
      setStatus({ linked: false, githubUsername: "", avatarUrl: "" });
      // Refresh user data
      get("/api/me").then((data: { user?: Parameters<typeof updateUser>[0] }) => { if (data.user) updateUser(data.user); }).catch(() => {});
    } catch (err: any) {
      showToast(err.message || "Failed to unlink", "error");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Card className="flex justify-center p-6"><Spinner /></Card>;

  const linked = status?.linked || user?.githubLinked;
  const username = status?.githubUsername || user?.githubUsername || "";
  const avatar = status?.avatarUrl || user?.githubAvatarUrl || "";

  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={<GitBranch size={15} />}
        title="GitHub"
        description="Connected identity"
        actions={linked ? <Badge tone="success">Linked</Badge> : undefined}
      />
      {linked ? (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            {avatar ? (
              <img src={avatar} alt="" className="h-8 w-8 shrink-0 rounded-full border bg-subtle" />
            ) : (
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border bg-subtle text-muted">
                <User size={15} />
              </span>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-fg">@{username}</div>
              <p className="truncate font-mono text-xs text-muted">github.com/{username}</p>
            </div>
          </div>
          <Btn loading={busy} onClick={unlinkGitHub}>
            <Unlink size={14} /> Unlink
          </Btn>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-fg">Not linked</div>
            <p className="text-xs text-muted">Link your GitHub identity to your OCD account.</p>
          </div>
          <Btn loading={busy} onClick={linkGitHub}>
            <LinkIcon size={14} /> Link GitHub
          </Btn>
        </div>
      )}
    </Card>
  );
}

export function AccountPage() {
  return (
    <PageShell width="md">
      <PageHeader title="Account" description="Profile, connected identities, and sign-in security." />

      <GitHubSection />
      <SecuritySection />
      <UserNtfySettings />
    </PageShell>
  );
}
