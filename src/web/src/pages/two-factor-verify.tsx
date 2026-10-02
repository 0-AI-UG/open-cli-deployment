import { useState, useEffect } from "react";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, logout } from "../stores/auth.ts";
import { Spinner, Btn, Card, AuthShell, InlineNotice } from "../components/ui.tsx";
import { PasskeyUnsupported } from "../components/passkey-unsupported.tsx";
import { Fingerprint } from "lucide-react";

export function TwoFactorVerifyPage() {
  const { tempToken, token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const supported = browserSupportsWebAuthn();

  const verify = async () => {
    if (!tempToken) return;
    setError("");
    setLoading(true);
    try {
      const options = await post("/api/auth/webauthn/login-options", { tempToken });
      const credential = await startAuthentication({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/login-verify", { tempToken, credential });
      login(res.token, res.user);
      window.location.hash = "#/";
    } catch (err: any) {
      setError(err.name === "NotAllowedError" ? "Passkey verification was cancelled." : err.message || "Passkey verification failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supported && tempToken) verify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <AuthShell title="Verify with passkey" description="Use Touch ID, Face ID, or a security key.">
      {!supported ? (
        <PasskeyUnsupported onBack={() => { logout(); window.location.hash = "#/login"; }} />
      ) : (
        <>
          <Card className="p-6 text-center">
            <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border bg-subtle text-fg">
              <Fingerprint size={22} />
            </span>
            {loading ? (
              <div className="space-y-3">
                <p className="text-sm text-fg-dim">Waiting for your passkey…</p>
                <div className="flex justify-center"><Spinner /></div>
              </div>
            ) : (
              <div className="space-y-4">
                {error && <InlineNotice tone="danger" className="text-left">{error}</InlineNotice>}
                <Btn onClick={verify} variant="primary" size="md" className="w-full">
                  <Fingerprint size={14} /> {error ? "Try again" : "Verify"}
                </Btn>
              </div>
            )}
          </Card>
          {!loading && (
            <p className="mt-4 text-center text-xs text-muted">
              <button
                type="button"
                onClick={() => { logout(); window.location.hash = "#/login"; }}
                className="transition-colors hover:text-fg"
              >
                Cancel and return to sign in
              </button>
            </p>
          )}
        </>
      )}
    </AuthShell>
  );
}
