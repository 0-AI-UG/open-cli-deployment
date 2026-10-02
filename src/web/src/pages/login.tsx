import { useState } from "react";
import { post } from "../api/client.ts";
import { login, setTempToken } from "../stores/auth.ts";
import { showToast, Card, Btn, AuthShell } from "../components/ui.tsx";
import { ArrowRight } from "lucide-react";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await post("/api/auth/login", { username, password });
      if (res.requires2FA) {
        setTempToken(res.tempToken);
        window.location.hash = "#/2fa-verify";
      } else if (res.requires2FASetup) {
        setTempToken(res.tempToken);
        window.location.hash = "#/2fa-setup";
      } else {
        login(res.token, res.user);
        window.location.hash = "#/";
      }
    } catch (err: any) {
      showToast(err.message || "Login failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell title="Sign in to OCD" description="Open CLI Deployment control panel">
      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-fg">Username</span>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" required autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-fg">Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </label>
          <Btn type="submit" variant="primary" size="md" loading={loading} className="mt-2 w-full">
            <span>Sign in</span><ArrowRight size={14} />
          </Btn>
        </form>
      </Card>
      <p className="mt-4 text-center text-xs text-muted">
        <a href="#/password-reset" className="transition-colors hover:text-fg">Forgot password?</a>
      </p>
    </AuthShell>
  );
}
