import { StorageMounts } from "../../components/storage-mounts.tsx";
import type { StorageMount } from "../../../../shared/storage-display.ts";
import { get } from "../../api/client.ts";
import { Badge, Card, CardHeader, DataRow, EmptyState, Btn, showToast, Table, CopyButton } from "../../components/ui.tsx";
import { RefreshCw, ExternalLink, Server as ServerIcon, Settings2, Globe, Database, Bell, HardDrive, Layers, MapPin } from "lucide-react";
import { InfoTip } from "./shared.tsx";
import { ReplicasTable } from "../../components/replicas-table.tsx";
import type { AppData, ReplicaData, MetricSample } from "../../types.ts";
import { DnsInstructionView } from "../../components/dns-instruction.tsx";

interface OverviewTabProps {
  app: AppData;
  appId: number;
  storage: AppStorageData | null;
  replicas: ReplicaData[];
  metricsHistory: MetricSample[];
  setReplicas: (r: ReplicaData[]) => void;
}

export type AppStorageData = {
  mounts: StorageMount[];
  current: { image_size_bytes?: number } | null;
  reclaimable_image_bytes_upper_bound: number;
  caveat: string;
};

export function OverviewTab({ app, appId, storage, replicas, metricsHistory, setReplicas }: OverviewTabProps) {
  const internalUrl = app.internal_protocol === "tcp"
    ? `tcp://${app.name}.ocd.internal:${app.container_port}`
    : `http://${app.name}.ocd.internal`;
  const bytes = (value?: number | null) => typeof value === "number" && value > 0
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : "—";

  const manifestDiffers = (app.last_manifest_config_revision ?? 0) !== (app.config_revision ?? 1);
  const placement = app.placement ?? [];
  const serverName = (id: number) => placement.find((entry) => entry.server_id === id)?.server_name ?? `srv#${id}`;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader title="Configuration" icon={<Settings2 size={15} />} />
          <div>
            <DataRow label="Immutable image" mono>
              <span className="truncate" title={app.image_ref}>{app.image_ref || "—"}</span>
              {app.image_ref && <CopyButton text={app.image_ref} />}
            </DataRow>
            <DataRow label="Configuration">OCD revision {app.config_revision ?? 1}</DataRow>
            {app.last_manifest_path && (
              <DataRow label="Last manifest">
                <span className="truncate font-mono text-xs" title={app.last_manifest_hash ?? undefined}>{app.last_manifest_path}</span>
                {manifestDiffers && <Badge tone="warning">Differs</Badge>}
              </DataRow>
            )}
            <DataRow label="Container port" mono>{app.container_port}</DataRow>
            <DataRow label="Readiness">
              <span className="truncate" title={app.health_check_command || app.health_check_file}>
                {app.health_check_mode || (app.health_check ? "http" : "container")}
                {app.health_check_file ? <span className="font-mono text-xs text-fg-dim">{` · ${app.health_check_file} ≤ ${app.health_check_max_age_seconds}s`}</span> : ""}
              </span>
            </DataRow>
            {replicas[0]?.host_port != null && (
              <DataRow label="Host port" mono>{replicas[0].host_port}</DataRow>
            )}
            <DataRow label="Volume intent">
              <span className="text-right">
                {String(app.volume_id || "").startsWith("local:")
                  ? "Server-local directory · shares server disk"
                  : (app.desired_volume_size ?? 0) < 0
                  ? "legacy · explicit manifest required"
                  : (app.desired_volume_size ?? 0) > 0
                  ? `${app.desired_volume_id ? `adopt ${app.desired_volume_id}` : "managed"} · ${app.desired_volume_size} GB → ${app.desired_volume_path || "/data"}`
                  : "none"}
              </span>
            </DataRow>
            <DataRow label="Volume actual">
              {app.volume_id
                ? <span className="break-all text-right font-mono text-xs">{app.volume_id} · {app.volume_mount}</span>
                : <span className="text-muted">none</span>}
            </DataRow>
            {app.deployed_by_username && <DataRow label="Last deployed by">{app.deployed_by_username}</DataRow>}
            {app.environment_name && <DataRow label="Environment"><a href="#/environments" className="font-medium text-fg">{app.environment_name}</a></DataRow>}
          </div>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          <CardHeader title="Connection" icon={<Globe size={15} />} />
          <div>
            {app.domain && app.public ? (
              <DataRow label="Public URL">
                <a href={`https://${app.domain}`} target="_blank" rel="noopener" className="truncate font-mono text-xs text-fg">https://{app.domain}</a>
                <CopyButton text={`https://${app.domain}`} />
                <a href={`https://${app.domain}`} target="_blank" rel="noopener" title="Open in new tab" className="inline-grid shrink-0 place-items-center rounded p-1 text-muted transition-colors hover:bg-subtle hover:text-fg"><ExternalLink size={12} /></a>
              </DataRow>
            ) : (
              <DataRow label="Public domain">
                <span className="text-fg-dim">Disabled</span>
                <Badge>Private</Badge>
              </DataRow>
            )}
            <DataRow label={<span className="inline-flex items-center gap-1">Internal URL <InfoTip text="Reachable from other apps on the private network. Set this in env vars when one app needs to call another." /></span>}>
              <span className="truncate font-mono text-xs">{internalUrl}</span>
              <CopyButton text={internalUrl} />
            </DataRow>
          </div>
          {app.dns_instruction && <div className="border-t px-4 py-3"><DnsInstructionView value={app.dns_instruction} /></div>}
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Placement" icon={<MapPin size={15} />} description="Declared in the manifest; change it with ocd deploy or ocd move" />
        {placement.length === 0 ? (
          <EmptyState message="No placement declared" icon={MapPin} className="!py-10" />
        ) : (
          <Table headers={["Server", "Declared", "Running"]}>
            {placement.map((entry) => (
              <tr key={entry.server_id}>
                <td><a href={`#/resources/servers/${entry.server_id}`} className="text-fg">{entry.server_name}</a></td>
                <td className="tabular-nums text-fg-dim">{entry.replicas}</td>
                <td className="tabular-nums text-fg-dim">{replicas.filter((replica) => replica.server_id === entry.server_id && replica.status === "running").length}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Replicas"
          icon={<ServerIcon size={15} />}
          description={replicas.length > 0 ? `${replicas.length} replica${replicas.length === 1 ? "" : "s"} · CPU sparkline covers the last hour` : undefined}
          actions={
            <Btn size="xs" variant="ghost" onClick={async () => {
              try {
                setReplicas(await get(`/api/apps/${appId}/metrics`));
                showToast("Metrics refreshed", "info");
              } catch (err) {
                console.error("Failed to refresh metrics:", err);
              }
            }}><RefreshCw size={12} /> Refresh metrics</Btn>
          }
        />
        {replicas.length === 0 ? (
          <EmptyState message="No replicas yet" icon={ServerIcon} className="!py-10" />
        ) : (
          <ReplicasTable
            context="app"
            replicas={replicas.map((r) => ({ ...r, server: { id: r.server_id, name: serverName(r.server_id) } }))}
            cpuSeries={(id) => metricsHistory.filter((s) => s.replica_id === id).map((s) => s.cpu_percent)}
          />
        )}
      </Card>

      {(app.storage_bindings || []).length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(app.storage_bindings || []).map((binding, index, all) => (
            // An odd one out spans the row rather than leaving half of it empty.
            <Card key={binding.name} className={`min-w-0 overflow-hidden ${all.length % 2 === 1 && index === all.length - 1 ? "lg:col-span-2" : ""}`}>
              <CardHeader
                title={<>Object storage · <span className="font-mono text-xs">{binding.name}</span></>}
                icon={<Database size={15} />}
                actions={<span title="Injected by OCD. Configure this binding in the app manifest."><Badge>OCD managed</Badge></span>}
              />
              <div>
                <DataRow label="Bucket" mono><span className="break-all">{binding.bucket}</span></DataRow>
                <DataRow label="Prefix" mono={!!binding.prefix}>
                  {binding.prefix ? <span className="break-all">{binding.prefix}</span> : <span className="text-muted">Bucket root</span>}
                </DataRow>
                <DataRow label="Permissions">
                  <span className="flex flex-wrap justify-end gap-1">{binding.permissions.map((permission) => <Badge key={permission}>{permission}</Badge>)}</span>
                </DataRow>
                <DataRow label="Token" mono><span className="break-all" title={binding.variables.token}>{binding.variables.token} · ••••••••</span></DataRow>
              </div>
            </Card>
          ))}
        </div>
      )}

      {Object.keys(app.notifications ?? {}).length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Notification bindings" icon={<Bell size={15} />} />
          <div className="divide-y">
            {Object.entries(app.notifications ?? {}).map(([name, binding]) => (
              <div key={name} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="min-w-0 flex-1 break-all font-mono text-xs font-medium text-fg">{name}</span>
                <div className="flex flex-wrap gap-1">{binding.permissions.map((permission) => <Badge key={permission}>{permission}</Badge>)}</div>
                <span className="font-mono text-xs text-muted" title="Credential generation">v{binding.generation}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {storage ? <div className="min-w-0 [&>*]:h-full"><StorageMounts mounts={storage.mounts} /></div> : (
          <Card className="min-w-0 overflow-hidden">
            <CardHeader title="Storage" icon={<HardDrive size={15} />} />
            <p className="px-4 py-3 text-sm text-muted">Storage inventory unavailable</p>
          </Card>
        )}
        <Card className="min-w-0 overflow-hidden">
          <CardHeader title="Image storage" icon={<Layers size={15} />} />
          {storage ? (
            <>
              <div>
                <DataRow label="Current artifact" mono>{bytes(storage.current?.image_size_bytes)}</DataRow>
                <DataRow label="Reclaimable upper bound" mono>{bytes(storage.reclaimable_image_bytes_upper_bound)}</DataRow>
              </div>
              <p className="border-t bg-subtle/40 px-4 py-2.5 text-xs text-muted">{storage.caveat}</p>
            </>
          ) : <p className="px-4 py-3 text-sm text-muted">Storage inventory unavailable</p>}
        </Card>
      </div>
    </div>
  );
}
