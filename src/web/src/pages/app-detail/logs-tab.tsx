import { Card, CardHeader, Btn } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { LogViewer } from "../../components/log-viewer.tsx";
import { ScrollText, RefreshCw } from "lucide-react";
import type { ReplicaData } from "../../types.ts";

interface LogsTabProps {
  logs: string;
  tail: number;
  setTail: (t: number) => void;
  loadLogs: () => void;
  replicas: ReplicaData[];
  selectedReplicaId: number | null;
  setSelectedReplicaId: (id: number | null) => void;
}

export function LogsTab({ logs, tail, setTail, loadLogs, replicas, selectedReplicaId, setSelectedReplicaId }: LogsTabProps) {
  const showReplicaSelect = replicas.length > 1;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Container logs"
        icon={<ScrollText size={15} />}
        description={`Last ${tail} lines`}
        className="flex-wrap"
        actions={<>
          {showReplicaSelect && (
            <div className="w-44">
              <NeoSelect
                value={selectedReplicaId != null ? String(selectedReplicaId) : String(replicas[0].id)}
                onChange={(v) => setSelectedReplicaId(parseInt(v))}
                options={replicas.map((r) => ({ value: String(r.id), label: r.container_name }))}
                compact
              />
            </div>
          )}
          <div className="w-28">
            <NeoSelect
              value={String(tail)}
              onChange={(v) => setTail(parseInt(v))}
              options={[50, 100, 200, 500].map((n) => ({ value: String(n), label: `${n} lines` }))}
              compact
            />
          </div>
          <Btn size="xs" onClick={loadLogs}><RefreshCw size={12} /> Refresh</Btn>
        </>}
      />
      <div className="p-3">
        <LogViewer logs={logs} />
      </div>
    </Card>
  );
}
