import { useState, useEffect } from "react";
import { get, put } from "../../api/client.ts";
import { Card, CardHeader, Btn, Badge, Field, DataRow, SkeletonCard, showToast } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { Globe, Save } from "lucide-react";
import { HetznerIcon } from "../../components/brand-icons";

const FORM_FOOTER = "flex flex-wrap justify-end gap-2 border-t bg-subtle/40 px-4 py-3";
const DEFAULT_REGIONS = ["fsn1", "nbg1", "hel1"];

export function HetznerSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ configured: false, s3Configured: false, s3Regions: DEFAULT_REGIONS });
  const [form, setForm] = useState({
    hetzner_api_token: "", hetzner_s3_access_key: "", hetzner_s3_secret_key: "", hetzner_s3_region: "fsn1",
    default_domain_suffix: "",
  });
  const [hetznerEditing, setHetznerEditing] = useState(false);
  const [domainEditing, setDomainEditing] = useState(false);

  const apply = (s: any) => {
    setStatus({
      configured: s.hetzner_configured === true,
      s3Configured: s.hetzner_s3_configured === true,
      s3Regions: Array.isArray(s.hetzner_s3_regions) && s.hetzner_s3_regions.length ? s.hetzner_s3_regions : DEFAULT_REGIONS,
    });
    setForm({
      hetzner_api_token: s.hetzner_api_token ?? "",
      hetzner_s3_access_key: s.hetzner_s3_access_key ?? "",
      hetzner_s3_secret_key: s.hetzner_s3_secret_key ?? "",
      hetzner_s3_region: s.hetzner_s3_region || "fsn1",
      default_domain_suffix: s.default_domain_suffix ?? "",
    });
  };

  const load = () => get("/api/settings").then(apply).catch(() => {}).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const setF = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (payload: Record<string, string>, done: () => void, message: string) => {
    setSaving(true);
    try {
      await put("/api/settings", payload);
      await load();
      showToast(message, "success");
      done();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <><SkeletonCard rows={2} label="Loading settings" /><SkeletonCard rows={1} /></>;

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          icon={<HetznerIcon size={15} />}
          title="Hetzner"
          description={`Cloud API ${status.configured ? "connected" : "not configured"} · Object Storage ${status.s3Configured ? `connected (${form.hetzner_s3_region})` : "not configured"}`}
          actions={<Btn size="xs" onClick={() => setHetznerEditing((open) => !open)}>{hetznerEditing ? "Close" : "Edit"}</Btn>}
        />
        {!hetznerEditing && <div>
          <DataRow label="Cloud API">{status.configured ? <Badge tone="success">Connected</Badge> : <Badge tone="warning">Not configured</Badge>}</DataRow>
          <DataRow label="Object Storage">{status.s3Configured ? <Badge tone="success">Connected · {form.hetzner_s3_region}</Badge> : <Badge>Not configured</Badge>}</DataRow>
        </div>}
        {hetznerEditing && <div className="animate-slide-up">
          <div className="px-4">
            <Field divider label="API token" align="start" hint="Hetzner Cloud API token with read & write access. OCD uses it to create servers, volumes, networks, and firewalls.">
              <input type="password" value={form.hetzner_api_token} onChange={setF("hetzner_api_token")} placeholder="Hetzner API token" autoComplete="new-password" />
            </Field>
          </div>
          <div className="border-t px-4 pt-4">
            <h3 className="text-sm font-semibold text-fg">Hetzner Object Storage</h3>
            <p className="mt-0.5 text-xs text-muted">Generate S3 credentials in Hetzner Console. These are separate from the Cloud API token and are stored encrypted by OCD.</p>
          </div>
          <div className="px-4">
            <Field divider label="Region">
              <NeoSelect
                value={form.hetzner_s3_region}
                onChange={(v) => setForm((f) => ({ ...f, hetzner_s3_region: v }))}
                options={status.s3Regions.map((region) => ({ value: region, label: region }))}
              />
            </Field>
            <Field divider label="Access key">
              <input type="password" value={form.hetzner_s3_access_key} onChange={setF("hetzner_s3_access_key")} placeholder="Hetzner S3 access key" autoComplete="off" />
            </Field>
            <Field divider label="Secret key" align="start" hint="Clear both key fields and save to disconnect Object Storage.">
              <input type="password" value={form.hetzner_s3_secret_key} onChange={setF("hetzner_s3_secret_key")} placeholder="Hetzner S3 secret key" autoComplete="new-password" />
            </Field>
          </div>
          <div className={FORM_FOOTER}>
            <Btn onClick={() => setHetznerEditing(false)}>Cancel</Btn>
            <Btn variant="primary" loading={saving} onClick={() => save({
              hetzner_api_token: form.hetzner_api_token,
              hetzner_s3_access_key: form.hetzner_s3_access_key,
              hetzner_s3_secret_key: form.hetzner_s3_secret_key,
              hetzner_s3_region: form.hetzner_s3_region,
            }, () => setHetznerEditing(false), "Hetzner settings saved")}><Save size={14} /> Save</Btn>
          </div>
        </div>}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          icon={<Globe size={15} />}
          title="App domain"
          description={form.default_domain_suffix || "No default app domain"}
          actions={<Btn size="xs" onClick={() => setDomainEditing((open) => !open)}>{domainEditing ? "Close" : "Edit"}</Btn>}
        />
        {!domainEditing && <DataRow label="App domain" mono>{form.default_domain_suffix || <span className="font-sans text-sm text-muted">Not set</span>}</DataRow>}
        {domainEditing && <div className="animate-slide-up">
          <div className="px-4">
            <Field divider label="App domain" align="start" hint="Used as the default domain suffix. OCD shows the DNS records to create but never changes DNS.">
              <input type="text" className="font-mono" value={form.default_domain_suffix} onChange={setF("default_domain_suffix")} placeholder="apps.example.com" />
            </Field>
          </div>
          <div className={FORM_FOOTER}>
            <Btn onClick={() => setDomainEditing(false)}>Cancel</Btn>
            <Btn variant="primary" loading={saving} onClick={() => save({ default_domain_suffix: form.default_domain_suffix }, () => setDomainEditing(false), "App domain saved")}><Save size={14} /> Save</Btn>
          </div>
        </div>}
      </Card>
    </>
  );
}
