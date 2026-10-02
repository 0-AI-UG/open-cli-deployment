import { useState, useEffect } from "react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { post } from "../api/client.ts";
import { useAuth, login, logout } from "../stores/auth.ts";
import { Spinner, Card, Btn, AuthShell, InlineNotice } from "../components/ui.tsx";
import { PasskeyUnsupported } from "../components/passkey-unsupported.tsx";
import { Fingerprint } from "lucide-react";

export function TwoFactorSetupPage() {
  const { tempToken, token } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const supported = browserSupportsWebAuthn();

  const register = async () => {
    if (!tempToken) return;
    setError("");
    setLoading(true);
    try {
      const options = await post("/api/auth/webauthn/register-options-from-login", { tempToken });
      const credential = await startRegistration({ optionsJSON: options });
      const res = await post("/api/auth/webauthn/register-verify-from-login", { tempToken, credential });
      login(res.token, res.user);
      window.location.hash = "#/";
    } catch (err: any) {
      setError(err.name === "NotAllowedError" ? "Passkey registration was cancelled." : err.message || "Passkey registration failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (supported && tempToken) register();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tempToken && !token) {
    window.location.hash = "#/login";
    return null;
  }

  return (
    <AuthShell title="Add a passkey" description="A passkey is required to secure your account." width="sm">
      {!supported ? (
        <PasskeyUnsupported onBack={() => { logout(); window.location.hash = "#/login"; }} />
      ) : (
        <Card className="p-6 text-center">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full border bg-subtle text-fg">
            <Fingerprint size={22} />
          </span>
          {loading ? (
            <div className="space-y-3">
              <p className="text-sm text-fg-dim">Follow your browser's prompt to register a passkey.</p>
              <div className="flex justify-center"><Spinner /></div>
            </div>
          ) : (
            <div className="space-y-4">
              {error ? (
                <InlineNotice tone="danger" className="text-left">{error}</InlineNotice>
              ) : (
                <p className="text-sm text-fg-dim">Use Touch ID, Face ID, Windows Hello, or a security key.</p>
              )}
              <Btn onClick={register} variant="primary" size="md" className="w-full">
                <Fingerprint size={14} /> {error ? "Try again" : "Register passkey"}
              </Btn>
            </div>
          )}
        </Card>
      )}
    </AuthShell>
  );
}
