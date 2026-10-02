import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { get } from "../api/client.ts";
import { Activity, Ban, CheckCircle2, ChevronLeft, ChevronRight, Clock, Loader2, RotateCcw, XCircle } from "lucide-react";
import { Badge, Btn, Card, PageShell, PageHeader, PageState, Spinner, StatusBadge } from "../components/ui.tsx";
import { useHashParam } from "../hooks/use-hash-param.ts";
import { useActiveIndicator } from "../hooks/use-active-indicator.ts";
import { humanizeStep, type OperationView } from "../hooks/useOperation.ts";

type Snapshot = {
  running: OperationView[];
  pending: OperationView[];
  recent: OperationView[];
  recent_total: number;
  engine: {
    heartbeat: string | null;
    concurrency: number;
    known_kinds: Array<{ kind: string; label: string; steps: number }>;
  };
};

type RecentFilter = "all" | "failures" | "needs_attention" | "cancelled";
const PAGE_SIZE = 50;
const FILTERS: Array<{ value: RecentFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "failures", label: "Failures" },
  { value: "needs_attention", label: "Needs review" },
  { value: "cancelled", label: "Cancelled" },
];

// Tile tone for the leading icon. StatusBadge carries the label; the tile makes
// failures scannable down the list (including "compensated", which the shared
// status palette treats as neutral).
function opTone(status: string): { tile: string; Icon: typeof CheckCircle2; spin?: boolean } {
  if (status === "done") return { tile: "border-success/20 bg-success/10 text-success", Icon: CheckCircle2 };
  if (status === "running") return { tile: "border-info/20 bg-info/10 text-info", Icon: Loader2, spin: true };
  if (status === "pending") return { tile: "bg-subtle text-muted", Icon: Clock };
  if (status === "failed" || status === "compensated" || status === "compensation_failed") return { tile: "border-danger/20 bg-danger/10 text-danger", Icon: XCircle };
  if (status === "compensating") return { tile: "border-warning/25 bg-warning/10 text-warning", Icon: RotateCcw };
  if (status === "cancelled") return { tile: "bg-subtle text-muted", Icon: Ban };
  return { tile: "bg-subtle text-muted", Icon: Activity };
}

function heartbeatLabel(raw: string | null): { text: string; healthy: boolean } {
  if (!raw) return { text: "no heartbeat", healthy: false };
  const last = new Date(raw).getTime();
  const age = Date.now() - last;
  if (age < 15000) return { text: `${Math.round(age / 1000)}s ago`, healthy: true };
  return { text: `stale (${Math.round(age / 1000)}s)`, healthy: false };
}

export function EnginePage() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [filter, setFilter] = useHashParam("filter", FILTERS.map((option) => option.value), "all");
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter]);
  const filterSlider = useActiveIndicator<HTMLDivElement>(filter);
  const [loadedHistoryKey, setLoadedHistoryKey] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const historyKey = `${filter}:${page}`;

  useEffect(() => {
    let cancelled = false;
    const requestKey = `${filter}:${page}`;
    setHistoryError(false);
    async function tick() {
      try {
        const data = await get(`/api/operations?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&filter=${filter}`);
        if (!cancelled) {
          setSnap(data);
          setLoadedHistoryKey(requestKey);
          setHistoryError(false);
        }
      } catch {
        if (!cancelled) setHistoryError(true);
      }
    }
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [filter, page]);

  if (!snap) return <PageState title="Loading operations" />;

  const hb = heartbeatLabel(snap.engine.heartbeat);
  const historyLoading = loadedHistoryKey !== historyKey;

  const historyTotal = snap.recent_total ?? snap.recent.length;

  return (
    <PageShell>
      <PageHeader title="Operations" description="Queued, running, and recently completed engine work." actions={<>
          <Badge tone={hb.healthy ? "success" : "danger"}>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
            Heartbeat {hb.text}
          </Badge>
          <Badge>Concurrency {snap.engine.concurrency}</Badge>
      </>} />

      <Section title="Running" count={snap.running.length}>
        {snap.running.length === 0 ? (
          <EmptyState label="No operations running" />
        ) : (
          <OpList ops={snap.running} showProgress />
        )}
      </Section>

      <Section title="Pending" count={snap.pending.length}>
        {snap.pending.length === 0 ? (
          <EmptyState label="Queue is empty" />
        ) : (
          <OpList ops={snap.pending} />
        )}
      </Section>

      <Section
        title="History"
        count={historyLoading ? undefined : historyTotal}
        actions={
          <div ref={filterSlider.containerRef} className="relative inline-flex rounded-full border border-line-strong bg-surface p-0.5" role="group" aria-label="Filter operation history">
            <span aria-hidden="true" className="rounded-full bg-primary" style={filterSlider.indicatorStyle} />
            {FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={filter === option.value}
                data-active={filter === option.value}
                onClick={() => setFilter(option.value)}
                className={`relative inline-flex h-7 items-center whitespace-nowrap rounded-full px-3 text-sm font-medium transition-colors duration-200 max-md:h-9 ${
                  filter === option.value ? "text-primary-fg" : "text-muted hover:text-fg"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
        footer={!historyLoading && historyTotal > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t bg-subtle/40 px-4 py-2.5">
            <span className="text-xs tabular-nums text-muted">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, snap.recent_total)} of {snap.recent_total}
            </span>
            <div className="flex gap-2">
              <Btn size="xs" disabled={page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={13} /> Newer</Btn>
              <Btn size="xs" disabled={(page + 1) * PAGE_SIZE >= snap.recent_total} onClick={() => setPage((p) => p + 1)}>Older <ChevronRight size={13} /></Btn>
            </div>
          </div>
        ) : undefined}
      >
        {historyLoading ? (
          <div role="status" className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted">
            <Spinner />
            {historyError ? "Could not load history. Retrying…" : "Loading history…"}
          </div>
        ) : snap.recent.length === 0 ? (
          <EmptyState label="No operations in this view" />
        ) : (
          <OpList ops={snap.recent} />
        )}
      </Section>
    </PageShell>
  );
}

function Section({ title, count, actions, footer, children }: { title: string; count?: number; actions?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <Card className="overflow-hidden">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-fg">{title}</h2>
            {count !== undefined && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-subtle px-1.5 text-2xs font-medium tabular-nums text-fg-dim">{count}</span>
            )}
          </div>
          {actions}
        </div>
        {children}
        {footer}
      </Card>
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="px-4 py-8 text-center text-sm text-muted">
      {label}
    </div>
  );
}

function OpList({ ops, showProgress }: { ops: OperationView[]; showProgress?: boolean }) {
  return (
    <div className="divide-y">
      {ops.map((op) => (
        <OpRow key={op.id} op={op} showProgress={showProgress} />
      ))}
    </div>
  );
}

function OpRow({ op, showProgress }: { op: OperationView; showProgress?: boolean }) {
  const progress =
    showProgress && op.total_steps > 0 && op.last_step
      ? `${op.last_step}`
      : null;
  const resource = (op.resource_labels ?? op.resource_keys).join(", ");
  const age = op.started_at
    ? formatDistanceToNow(new Date(op.started_at.replace(" ", "T") + "Z"), { addSuffix: true })
    : null;
  const tone = opTone(op.status);
  return (
    <a
      href={`#/engine/op/${op.id}`}
      className="group block px-4 py-3 transition-colors hover:bg-subtle/50"
    >
      <div className="flex items-center gap-3">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-md border ${tone.tile}`}>
          <tone.Icon size={15} className={tone.spin ? "animate-spin" : ""} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-fg group-hover:underline">{op.label || op.kind}</span>
            <span className="shrink-0 font-mono text-xs text-muted">#{op.id}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
            {resource && <span className="min-w-0 truncate font-mono">{resource}</span>}
            {resource && <span aria-hidden="true">·</span>}
            <span className="shrink-0">
              {op.trigger}
              {age ? ` · ${age}` : ""}
            </span>
          </div>
        </div>
        <StatusBadge status={op.status} />
        <ChevronRight size={14} className="hidden shrink-0 text-muted transition-colors group-hover:text-fg sm:block" />
      </div>
      {progress && (
        <div className="mt-2 pl-11 text-xs text-fg-dim">
          {humanizeStep(progress)}
        </div>
      )}
      {(op.error?.message || op.error?.compensation_error) && (
        <div className="ml-11 mt-2 break-words rounded-md border border-danger/20 bg-danger/5 px-2.5 py-1.5 font-mono text-xs text-danger">
          {op.error.message || op.error.compensation_error}
          {op.last_step ? <span className="font-sans text-muted"> · Step: {humanizeStep(op.last_step)}</span> : null}
        </div>
      )}
    </a>
  );
}
