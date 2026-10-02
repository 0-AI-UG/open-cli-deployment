import { PageShell, PageHeader } from "../../components/ui.tsx";
import { TabBar } from "../../components/tab-bar.tsx";
import { useHashParam } from "../../hooks/use-hash-param.ts";
import { HetznerSettings } from "./hetzner-settings.tsx";
import { BuildSettings } from "./build-settings.tsx";
import { PanelSettings } from "./panel-settings.tsx";
import { UsersSettings } from "./users-settings.tsx";

type SettingsSection = "hetzner" | "build" | "panel" | "users";

const SECTIONS: Array<{ key: SettingsSection; label: string }> = [
  { key: "hetzner", label: "Hetzner & Domain" },
  { key: "build", label: "Build" },
  { key: "panel", label: "Panel" },
  { key: "users", label: "Users" },
];

export function SettingsPage() {
  const [section, setSection] = useHashParam("section", SECTIONS.map((item) => item.key), "hetzner");
  return (
    <PageShell>
      <PageHeader title="Settings" description="Hetzner, app domain, build connections, panel, and user access." />
      <TabBar tabs={SECTIONS} active={section} onChange={setSection} />
      {section === "hetzner" && <HetznerSettings />}
      {section === "build" && <BuildSettings />}
      {section === "panel" && <PanelSettings />}
      {section === "users" && <UsersSettings />}
    </PageShell>
  );
}
