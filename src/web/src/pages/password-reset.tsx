import { useState } from "react";
import { post } from "../api/client.ts";
import { showToast, Btn, Card, AuthShell } from "../components/ui.tsx";
import { Fingerprint, ArrowLeft } from "lucide-react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { PasskeyUnsupported } from "../components/passkey-unsupported.tsx";

export function PasswordResetPage() {
  const [username, setUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const supported = browserSupportsWebAuthn();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) return showToast("Enter your username first", "error");
    if (newPassword !== confirm) return showToast("Passwords do not match", "error");
    if (newPassword.length < 8) return showToast("Password must be at least 8 characters", "error");
    setLoading(true);
    try {
      const options = await post("/api/auth/password-reset/webauthn-options", { username });
      const credential = await startAuthentication({ optionsJSON: options });
      await post("/api/auth/password-reset/webauthn-verify", { username, credential, newPassword });
      showToast("Password reset. You can now sign in.", "success");
      window.location.hash = "#/login";
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        showToast("Passkey verification was cancelled.", "error");
      } else {
        showToast(err.message || "Password reset failed", "error");
      }
    } finally {
      setLoading(false);
    }
  };

  const fieldLabel = "block text-sm font-medium text-fg";

  return (
    <AuthShell title="Reset password" description="Choose a new password, then confirm it's you with your passkey.">
      {!supported ? (
        <PasskeyUnsupported onBack={() => { window.location.hash = "#/login"; }} />
      ) : (
        <>
          <Card className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <label className="block space-y-1.5">
                <span className={fieldLabel}>Username</span>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" required autoFocus />
              </label>
              <label className="block space-y-1.5">
                <span className={fieldLabel}>New password</span>
                <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
              </label>
              <label className="block space-y-1.5">
                <span className={fieldLabel}>Confirm new password</span>
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="••••••••" required minLength={8} />
              </label>
              <Btn type="submit" variant="primary" size="md" loading={loading} className="mt-2 w-full">
                <Fingerprint size={14} /><span>Verify and reset</span>
              </Btn>
            </form>
          </Card>
          <p className="mt-4 text-center text-xs text-muted">
            <a href="#/login" className="inline-flex items-center gap-1 transition-colors hover:text-fg">
              <ArrowLeft size={12} /> Back to sign in
            </a>
          </p>
        </>
      )}
    </AuthShell>
  );
}
