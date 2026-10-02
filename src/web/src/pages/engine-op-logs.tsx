import { Download, ScrollText, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "../api/client.ts";
import { Badge, Card, CardHeader, Btn, Spinner, PageShell, PageHeader, StatusBadge } from "../components/ui.tsx";
import { LogViewer } from "../components/log-viewer.tsx";
import { useOperation, TERMINAL_STATUSES } from "../hooks/useOperation.ts";

type LogRow = {
  id: number;
  op_id: number;
  ts: string;
  level: string;
  message: string;
};

function rowToLine(l: LogRow): string {
  const level = l.level.toUpperCase();
  return `${l.ts} ${level} ${l.message}`;
}

export function EngineOpLogsPage({ opId }: { opId: number }) {
  const op = useOperation(opId);
  const active = op ? !TERMINAL_STATUSES.has(op.status) : true;

  const [rows, setRows] = useState<LogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const sinceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    sinceRef.current = 0;
    setRows([]);
    setLoaded(false);

    async function tick() {
      while (!cancelled) {
        try {
          const wait = active ? 15000 : 0;
          const data = await get(`/api/operations/${opId}/logs?since=${sinceRef.current}&wait=${wait}`);
          if (cancelled) return;
          const incoming: LogRow[] = Array.isArray(data.logs) ? data.logs : [];
          if (incoming.length > 0) {
            sinceRef.current = incoming[incoming.length - 1].id;
            setRows((prev) => [...prev, ...incoming]);
          }
          setLoaded(true);
          const terminal = ["done", "failed", "cancelled", "compensated", "compensation_failed"].includes(data.status);
          if (terminal && incoming.length === 0) return;
          if (!active && incoming.length === 0) return;
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    tick();
    return () => { cancelled = true; };
  }, [opId, active, reloadTick]);

  const logsText = useMemo(() => rows.map(rowToLine).join("\n"), [rows]);

  function downloadLogs() {
    const blob = new Blob([logsText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `op-${opId}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <PageShell>
      <PageHeader
        backHref={`#/engine/op/${opId}`}
        backLabel="Back to operation"
        eyebrow="Operation logs"
        title={op ? `${op.kind} #${opId}` : `Operation #${opId}`}
        meta={op && (
            <>
              <StatusBadge status={op.status} />
              <span className="min-w-0 break-words font-mono text-xs">{(op.resource_labels ?? op.resource_keys).join(", ")}</span>
              {active ? <Badge tone="info"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />Live</Badge> : null}
            </>
        )}
      />

      {!loaded && !op ? (
        <div className="flex min-h-[200px] items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader
            title="Engine logs"
            icon={<ScrollText size={15} />}
            description={`${rows.length} line${rows.length === 1 ? "" : "s"}`}
            actions={<>
              <Btn size="xs" onClick={downloadLogs} disabled={rows.length === 0}>
                <Download size={13} /> Download
              </Btn>
              <Btn size="xs" onClick={() => setReloadTick((t) => t + 1)}>
                <RefreshCw size={13} /> Refresh
              </Btn>
            </>}
          />
          <div className="p-3">
            <LogViewer
              logs={logsText || (loaded ? "No log lines captured yet." : "")}
              className="max-h-[70vh]"
            />
          </div>
        </Card>
      )}
    </PageShell>
  );
}
