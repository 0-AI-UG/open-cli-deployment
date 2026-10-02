import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { runCliAction } from "../../api/cli-actions.ts";
import { Badge, Btn, Card, CardHeader, Stat, Table, humanize, portalAnchorRect, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { MapPin, History, ArrowRightLeft, Server as ServerIcon } from "lucide-react";
import { type ResourceOpsResult } from "../../hooks/useOperation.ts";
import type { AppData, ReplicaData, ReplicaEvent, ServerData } from "../../types.ts";

interface PlacementTabProps {
  app: AppData;
  appId: number;
  replicas: ReplicaData[];
  replicaEvents: ReplicaEvent[];
  allServers: ServerData[];
  ops: ResourceOpsResult;
  onMoved: () => void;
}

export function PlacementTab({
  app,
  appId,
  replicas,
  replicaEvents,
  allServers,
  ops,
  onMoved,
}: PlacementTabProps) {
  const running = replicas.filter((replica) => replica.status === "running").length;
  const placement = app.placement ?? [];
  const desired = placement.reduce((sum, entry) => sum + entry.replicas, 0);
  const [movingFrom, setMovingFrom] = useState<number | null>(null);
  // A move target must be a ready app server the app is not already placed on.
  const placedIds = new Set(placement.map((entry) => entry.server_id));
  const moveTargets = allServers.filter((server) =>
    !placedIds.has(server.id) && !server.build_worker && (!server.status || server.status === "ready"));

  const handleMove = async (sourceId: number, targetId: string) => {
    setMovingFrom(sourceId);
    try {
      await runCliAction("app.move", {
        app: String(appId),
        source: String(sourceId),
        target: targetId,
      });
      onMoved();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setMovingFrom(null);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader title="Placement" icon={<MapPin size={15} />} description="Declared in the manifest; OCD runs exactly this many replicas on each server" />
        <div className="grid grid-cols-2 gap-px bg-line">
          <Stat className="bg-surface px-4 py-3.5" label="Running" value={running} tone={running < desired ? "warning" : undefined} />
          <Stat className="bg-surface px-4 py-3.5" label="Declared" value={desired} />
        </div>
        <Table headers={["Server", "Declared", "Running", ""]}>
          {placement.map((entry) => (
            <tr key={entry.server_id}>
              <td className="text-fg">{entry.server_name}</td>
              <td className="tabular-nums text-fg-dim">{entry.replicas}</td>
              <td className="tabular-nums text-fg-dim">{replicas.filter((replica) => replica.server_id === entry.server_id && replica.status === "running").length}</td>
              <td className="text-right">
                <PermissionGate permission="scaling.migrate" appId={appId} environmentId={app.environment_id}>
                  <MoveMenu
                    targets={moveTargets}
                    loading={
                      movingFrom === entry.server_id ||
                      ops.active.some(
                        (o) => o.kind === "move" && (o.input as { fromServerId?: number })?.fromServerId === entry.server_id,
                      )
                    }
                    disabled={ops.isBusy}
                    onPick={(targetId) => handleMove(entry.server_id, targetId)}
                  />
                </PermissionGate>
              </td>
            </tr>
          ))}
        </Table>
        <p className="border-t bg-subtle/40 px-4 py-2.5 text-xs text-muted">
          Placement is declared in the app manifest (<code className="font-mono">placement</code>). Change it with <code className="font-mono">ocd deploy</code>, or move a server's replicas with <code className="font-mono">ocd move</code> or the Move action above.
        </p>
      </Card>

      {replicaEvents.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Recent events" icon={<History size={15} />} description={`Latest ${Math.min(replicaEvents.length, 20)}`} />
          <Table headers={["When", "Event", "From → To", "Reason"]}>
            {replicaEvents.slice(0, 20).map((event) => (
              <tr key={event.id}>
                <td className="whitespace-nowrap text-xs text-muted">{new Date(`${event.created_at}Z`).toLocaleString()}</td>
                <td><Badge tone={event.to_count > event.from_count ? "info" : "neutral"}>{humanize(event.event_type)}</Badge></td>
                <td className="whitespace-nowrap tabular-nums text-fg">{event.from_count} → {event.to_count}</td>
                <td className="text-fg-dim">{event.reason || "—"}</td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

function MoveMenu({ targets, loading, disabled, onPick }: {
  targets: ServerData[];
  loading: boolean;
  disabled: boolean;
  onPick: (targetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!triggerRef.current) return;
      const r = portalAnchorRect(triggerRef.current);
      setPos({ top: r.bottom + 4, left: r.right });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={triggerRef} className="inline-block">
      <Btn
        size="xs"
        variant="ghost"
        loading={loading}
        disabled={disabled}
        title="Move every replica on this server to another server and update the placement"
        onClick={() => setOpen((o) => !o)}
      >
        <ArrowRightLeft size={12} /> Move
      </Btn>
      {open && !disabled && pos && createPortal(
        <div
          ref={menuRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, transform: "translateX(-100%)" }}
          className="z-50 min-w-44 animate-pop-in rounded-lg border bg-surface p-1 shadow-pop"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-xs text-muted">Move to server</div>
          {targets.length === 0 ? (
            <div className="px-2.5 py-1.5 text-sm text-fg-dim">
              No eligible servers
            </div>
          ) : (
            targets.map((s) => (
              <button
                key={s.id}
                onClick={() => { setOpen(false); onPick(String(s.id)); }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-fg transition-colors hover:bg-subtle"
              >
                <ServerIcon size={14} className="shrink-0 text-muted" />
                {s.name.replace(/^ocd-/, "")}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
