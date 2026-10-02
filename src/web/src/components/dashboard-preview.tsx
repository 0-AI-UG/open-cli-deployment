import { Box, ChevronDown, ExternalLink, MoreHorizontal, RefreshCw, Sparkles, TerminalSquare } from "lucide-react";
import { Badge, Btn, Card, CardHeader, Hero, Stat, StatRow, StatusBadge, Logo } from "./ui.tsx";

// The overview page as it will look once apps are deployed, built from the same
// primitives as the real dashboard. The setup page feeds it the domain suffix
// being typed, which shows up in the app addresses in view. Only values that
// land in the visible, uncropped area are wired up, so typing never shifts
// layout the user can't see. It renders at desktop width,
// scaled down, and is meant to run off the right and bottom edges of its
// container (which clips it), like a window peeking into the page.

const STAGE_WIDTH = 1200;

type PreviewApp = {
  name: string;
  sub?: string; // subdomain under the domain suffix; omitted for internal apps
  internal?: string;
  status: string;
  replicas?: number;
  private?: boolean;
};

const APPS: PreviewApp[] = [
  { name: "web", sub: "www", status: "running", replicas: 3 },
  { name: "api", sub: "api", status: "deploying", replicas: 2 },
  { name: "worker", internal: "worker.ocd.internal", status: "running", private: true },
  { name: "postgres", internal: "postgres.ocd.internal:5432", status: "running", private: true },
  { name: "imgproxy", sub: "img", status: "paused" },
  { name: "docs", sub: "docs", status: "running" },
  { name: "redis", internal: "redis.ocd.internal:6379", status: "running", private: true },
  { name: "cron", internal: "cron.ocd.internal", status: "running", private: true },
  { name: "mailer", internal: "mailer.ocd.internal", status: "running", private: true },
];

const NAV = ["Overview", "Environments", "Resources", "Incidents", "Operations", "Settings"];

export function DashboardPreview({ domainSuffix, scale = 0.8 }: { domainSuffix: string; scale?: number }) {
  const suffix = domainSuffix.trim().replace(/^\.+|\.+$/g, "") || "apps.example.com";
  const running = APPS.filter((app) => app.status === "running").length;
  const paused = APPS.filter((app) => app.status === "paused").length;

  return (
    <div aria-hidden="true" inert>
      <div
        className="pointer-events-none origin-top-left select-none border-l border-t border-frame/25 bg-canvas shadow-[0_30px_80px_-24px_rgb(28_28_26/0.35)]"
        style={{ width: STAGE_WIDTH, minHeight: `${100 / scale}vh`, transform: `scale(${scale})` }}
      >
        <header className="rule-dashed grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-4 px-6">
          <span className="flex h-10 items-center gap-2 justify-self-start text-fg">
            <span className="text-brand"><Logo size={28} mono /></span>
          </span>
          <nav className="flex items-center gap-0.5">
            {NAV.map((label, index) => (
              <span
                key={label}
                className={`inline-flex h-9 items-center whitespace-nowrap rounded-full px-3.5 text-sm font-medium ${index === 0 ? "bg-surface text-fg ring-1 ring-inset ring-line-strong" : "text-muted"}`}
              >
                {label}
              </span>
            ))}
          </nav>
          <div className="flex items-center gap-1.5 justify-self-end">
            <span className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg"><TerminalSquare size={14} /> Install CLI</span>
            <span className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg"><Sparkles size={14} /> Agent skill</span>
            <span className="inline-flex h-9 max-w-56 items-center gap-2 whitespace-nowrap rounded-full border border-line-strong bg-surface pl-1 pr-2.5 text-sm font-medium">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-2xs font-semibold text-primary-fg">Y</span>
              <span className="truncate text-fg">you</span>
              <ChevronDown size={14} className="shrink-0 text-muted" />
            </span>
          </div>
        </header>

        <main className="space-y-6 px-10 py-8">
          <Hero
            title="Overview"
            description={`${APPS.length} apps and 1 stack. Everything is healthy.`}
            status={{ label: `Deploying api to api.${suffix}` }}
            actions={<>
              <Btn variant="primary">View operations</Btn>
              <Btn><RefreshCw size={14} /> Refresh</Btn>
            </>}
          />

          <StatRow>
            <Stat label="Apps" value={APPS.length} className="px-5 py-4" />
            <Stat label="Stacks" value={1} className="px-5 py-4" />
            <Stat label="Running" value={running} tone="success" className="px-5 py-4" />
            <Stat label="Paused" value={paused} className="px-5 py-4" />
          </StatRow>

          <Card>
            <CardHeader title="Applications" description={`${APPS.length} standalone · 1 stack`} />
            <div className="divide-y">
              {APPS.map((app) => {
                const address = app.internal ?? `${app.sub}.${suffix}`;
                return (
                  <div key={app.name} className="flex items-center justify-between gap-4 py-3 pl-4 pr-3">
                    <div className={`flex min-w-0 flex-1 items-center gap-3 ${app.status === "paused" ? "opacity-60" : ""}`}>
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted"><Box size={15} /></span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-fg">{app.name}</span>
                          {app.private && <Badge>Private</Badge>}
                          {(app.replicas ?? 1) > 1 && <Badge>{app.replicas} replicas</Badge>}
                        </div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1 text-muted">
                          <span className="truncate font-mono text-xs">{address}</span>
                          {!app.internal && <ExternalLink size={11} className="shrink-0" />}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <StatusBadge status={app.status} />
                      <span className="grid h-8 w-8 place-items-center text-muted"><MoreHorizontal size={16} /></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </main>
      </div>
    </div>
  );
}
