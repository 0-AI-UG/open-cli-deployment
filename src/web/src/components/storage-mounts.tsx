import type { ReactNode } from "react";
import { Folder, HardDrive } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, humanize, statusTone } from "./ui.tsx";
import { storageUsage, type StorageMount } from "../../../shared/storage-display.ts";

function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={`min-w-0 break-all text-fg ${mono ? "font-mono" : ""}`}>{children}</dd>
    </>
  );
}

export function StorageMounts({ mounts, title = "Storage" }: { mounts: StorageMount[]; title?: string }) {
  return <Card className="overflow-hidden">
    <CardHeader
      title={title}
      icon={<HardDrive size={15} />}
      description={mounts.length ? `${mounts.length} persistent mount${mounts.length === 1 ? "" : "s"}` : undefined}
    />
    {!mounts.length && <EmptyState message="No persistent directories recorded." icon={Folder} className="py-10" />}
    <div className="divide-y">
      {mounts.map((mount, index) => {
        const local = mount.kind === "local-directory";
        const Icon = local ? Folder : HardDrive;
        return <div key={`${mount.id}:${index}`} className="px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted"><Icon size={15} /></span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-fg">{mount.app_name}</span>
                <Badge tone={statusTone(mount.state)}>{humanize(mount.state)}</Badge>
              </div>
              <div className="mt-0.5 text-xs text-muted">{local ? "Server-local directory" : "Hetzner block volume"}</div>
            </div>
          </div>
          <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 rounded-md border bg-canvas/50 px-3 py-2.5 text-xs">
            <Fact label="Usage">{storageUsage(mount.used_bytes)}</Fact>
            {local && <Fact label="Allocation">Shares server disk · no separate storage charge</Fact>}
            <Fact label="Server" mono={!!mount.server_name}>{mount.server_name || "Host unavailable"}</Fact>
            <Fact label="Host path" mono>{mount.host_path}</Fact>
            {mount.container_path && <Fact label="Container path" mono>{mount.container_path}</Fact>}
          </dl>
        </div>;
      })}
    </div>
  </Card>;
}
