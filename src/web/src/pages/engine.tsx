import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { get } from "../api/client.ts";
import { Badge, PageShell, PageHeader, PageState } from "../components/ui.tsx";
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

function statusColor(status: string): string {
  if (status === "done") return "bg-accent text-fg";
  if (status === "running") return "bg-accent-blue text-white";
  if (status === "pending") return "bg-alt text-fg";
  if (status === "failed" || status === "compensated") return "bg-accent-red text-white";
  if (status === "compensation_failed") return "bg-accent-red text-white border-dashed";
  if (status === "compensating") return "bg-accent-amber text-fg";
  if (status === "cancelled") return "bg-alt text-fg-dim";
  return "bg-alt text-fg";
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
  const [filter, setFilter] = useState<RecentFilter>("all");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const data = await get(`/api/operations?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&filter=${filter}`);
        if (!cancelled) setSnap(data);
      } catch {
        /* ignore */
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

  return (
    <PageShell>
      <PageHeader title="Operations" description="Queued, running, and recently completed engine work." actions={<>
          <Badge tone={hb.healthy ? "success" : "danger"}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${hb.healthy ? "bg-fg" : "bg-white"}`} />
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

      <Section title="History" count={snap.recent_total ?? snap.recent.length}>
        <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter operation history">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => { setSnap(null); setFilter(option.value); setPage(0); }}
              className={`border-2 border-fg px-2 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${
                filter === option.value ? "bg-fg text-bg" : "bg-bg-raised text-fg hover:bg-alt"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {snap.recent.length === 0 ? (
          <EmptyState label="No operations in this view" />
        ) : (
          <OpList ops={snap.recent} />
        )}
        {(snap.recent_total ?? snap.recent.length) > PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between gap-3 font-mono text-[10px]">
            <span className="text-fg-dim">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, snap.recent_total)} of {snap.recent_total}
            </span>
            <div className="flex gap-2">
              <button type="button" disabled={page === 0} onClick={() => { setSnap(null); setPage((p) => p - 1); }} className="border-2 border-fg px-2 py-1 disabled:opacity-40">Newer</button>
              <button type="button" disabled={(page + 1) * PAGE_SIZE >= snap.recent_total} onClick={() => { setSnap(null); setPage((p) => p + 1); }} className="border-2 border-fg px-2 py-1 disabled:opacity-40">Older</button>
            </div>
          </div>
        )}
      </Section>
    </PageShell>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="font-mono text-sm font-bold uppercase tracking-wider">{title}</h2>
        <span className="text-[10px] font-mono text-fg-dim">({count})</span>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="border-2 border-dashed border-fg/30 py-8 text-center text-xs font-mono text-fg-dim">
      {label}
    </div>
  );
}

function OpList({ ops, showProgress }: { ops: OperationView[]; showProgress?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
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
  return (
    <a
      href={`#/engine/op/${op.id}`}
      className="block border-2 border-fg bg-bg-raised shadow-neo-sm hover:translate-x-0.5 hover:translate-y-0.5 hover:shadow-neo-none transition-all px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <span
          className={`font-mono text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 border-2 border-fg ${statusColor(op.status)}`}
        >
          {op.status}
        </span>
        <span className="font-mono text-xs font-bold">{op.label || op.kind}</span>
        <span className="font-mono text-[10px] text-fg-dim">#{op.id}</span>
        <span className="font-mono text-[10px] text-fg-dim">{resource}</span>
        <span className="font-mono text-[10px] text-fg-dim ml-auto">
          {op.trigger}
          {age ? ` · ${age}` : ""}
        </span>
      </div>
      {progress && (
        <div className="mt-1 font-mono text-[10px] text-fg-dim">
          {humanizeStep(progress)}
        </div>
      )}
      {(op.error?.message || op.error?.compensation_error) && (
        <div className="mt-2 border-l-2 border-accent-red pl-2 font-mono text-[10px] text-fg break-words">
          <span className="font-bold">Why: </span>{op.error.message || op.error.compensation_error}
          {op.last_step ? <span className="text-fg-dim"> · Step: {humanizeStep(op.last_step)}</span> : null}
        </div>
      )}
    </a>
  );
}
