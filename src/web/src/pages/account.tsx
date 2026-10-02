import { UserNtfySettings } from "../components/ntfy-settings.tsx";
import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { Badge, Card, CardHeader, Btn, SkeletonCard, showToast, PageShell, PageHeader } from "../components/ui.tsx";
import { Shield, Fingerprint, Trash2, LogOut, Plus } from "lucide-react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { logout } from "../stores/auth.ts";

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

  if (loading) return <SkeletonCard rows={2} label="Loading security" />;

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

export function AccountPage() {
  return (
    <PageShell width="md">
      <PageHeader title="Account" description="Profile, connected identities, and sign-in security." />

      <SecuritySection />
      <UserNtfySettings />
    </PageShell>
  );
}
