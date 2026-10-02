import { PageShell, PageHeader } from "../components/ui.tsx";
import { TabBar } from "../components/tab-bar.tsx";
import { OperationsPanel } from "./engine.tsx";
import { IncidentsPanel } from "./incidents.tsx";

type ActivityTab = "operations" | "incidents";

const TABS: Array<{ key: ActivityTab; label: string }> = [
  { key: "operations", label: "Operations" },
  { key: "incidents", label: "Incidents" },
];

const TAB_HASH: Record<ActivityTab, string> = {
  operations: "#/engine",
  incidents: "#/incidents",
};

/** Activity: engine operations and monitoring incidents, read-only. Each tab
 *  keeps its own route (#/engine, #/incidents) so existing links still land. */
export function ActivityPage({ tab }: { tab: ActivityTab }) {
  return (
    <PageShell>
      <PageHeader title="Activity" description="Engine operations and monitoring incidents across the fleet." />
      <TabBar tabs={TABS} active={tab} onChange={(next) => { window.location.hash = TAB_HASH[next]; }} />
      {tab === "operations" ? <OperationsPanel /> : <IncidentsPanel />}
    </PageShell>
  );
}
