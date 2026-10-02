import { useState } from "react";
import { post } from "../api/client.ts";
import { setTempToken } from "../stores/auth.ts";
import { showToast, Card, Btn, AuthShell } from "../components/ui.tsx";
import { ArrowRight } from "lucide-react";
import { DashboardPreview } from "../components/dashboard-preview.tsx";

export function SetupPage() {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    username: "",
    password: "",
    confirmPassword: "",
    default_domain_suffix: "",
  });

  const set = (key: string) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const handleSubmit = async () => {
    if (!form.username || !form.password) return showToast("Username and password are required", "error");
    if (form.password.length < 8) return showToast("Password must be at least 8 characters", "error");
    if (form.password !== form.confirmPassword) return showToast("Passwords don't match", "error");
    setLoading(true);
    try {
      const result = await post("/api/setup/complete", form);
      setTempToken(result.tempToken);
      window.location.hash = "#/2fa-setup";
    } catch (error: any) {
      showToast(error.message || "Setup failed", "error");
    } finally {
      setLoading(false);
    }
  };

  const fieldLabel = "block text-sm font-medium text-fg";

  return (
    <AuthShell
      title="Initial setup"
      description="Create the administrator account for this panel."
      width="md"
      aside={<DashboardPreview domainSuffix={form.default_domain_suffix} />}
    >
      <Card className="p-6">
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className={fieldLabel}>Username</span>
            <input type="text" value={form.username} onChange={set("username")} placeholder="admin" autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className={fieldLabel}>Password</span>
            <input type="password" value={form.password} onChange={set("password")} placeholder="Min 8 characters" />
          </label>
          <label className="block space-y-1.5">
            <span className={fieldLabel}>Confirm password</span>
            <input type="password" value={form.confirmPassword} onChange={set("confirmPassword")} placeholder="Confirm password" />
          </label>
          <div className="border-t pt-4">
            <label className="block space-y-1.5">
              <span className="flex items-baseline justify-between gap-2">
                <span className={fieldLabel}>Default domain suffix</span>
                <span className="text-xs text-muted">Optional</span>
              </span>
              <input type="text" value={form.default_domain_suffix} onChange={set("default_domain_suffix")} placeholder="apps.example.com" className="font-mono" />
            </label>
            <p className="mt-1.5 text-xs text-muted">
              OCD only shows the DNS records you should create; it never changes DNS.
            </p>
          </div>
          <Btn onClick={handleSubmit} variant="primary" size="md" loading={loading} className="w-full">
            <span>Complete setup</span><ArrowRight size={14} />
          </Btn>
        </div>
      </Card>
    </AuthShell>
  );
}
