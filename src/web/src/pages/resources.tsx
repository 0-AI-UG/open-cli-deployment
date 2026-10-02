import { useState, useEffect } from "react";
import { get } from "../api/client.ts";
import { Badge, Card, CardHeader, EmptyState, InlineNotice, showToast, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { Cloud, HardDrive, Server } from "lucide-react";
import { HetznerIcon } from "../components/brand-icons";
import type { ResourcesData } from "../types.ts";
import { TabBar } from "../components/tab-bar.tsx";
import { useHashParam } from "../hooks/use-hash-param.ts";

type ResourceSection = "servers" | "volumes" | "object-storage";

const RESOURCE_SECTIONS: Array<{ key: ResourceSection; label: string }> = [
  { key: "servers", label: "Servers" },
  { key: "volumes", label: "Volumes" },
  { key: "object-storage", label: "Object Storage" },
];

/** Read-only inventory. Creating and deleting servers, volumes, and buckets is
 *  done with the CLI (ocd servers / ocd volumes / ocd buckets). */
export function ResourcesPage() {
  const [section, setSection] = useHashParam("section", RESOURCE_SECTIONS.map((item) => item.key), "servers");
  const [data, setData] = useState<ResourcesData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get("/api/resources")
      .then(setData)
      .catch((err: Error) => showToast(err.message, "error"))
      .finally(() => setLoading(false));
  }, []);

  const fmtPrice = (eur: number | null | undefined) => {
    if (eur == null) return "—";
    return `€${eur.toFixed(2)}`;
  };

  if (loading) return <PageState title="Loading infrastructure" />;

  const rowClass = "relative flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-subtle/50";
  const tileClass = "grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted";
  const sep = <span className="text-line-strong">·</span>;

  return (
    <PageShell>
      <PageHeader title="Infrastructure" description="Servers, volumes, and S3 buckets. Manage them with ocd servers, ocd volumes, and ocd buckets." />

      <TabBar tabs={RESOURCE_SECTIONS} active={section} onChange={setSection} />

      {/* Servers */}
      {section === "servers" && <Card className="overflow-hidden">
        <CardHeader
          title="Servers"
          icon={<Server size={15} />}
          description={`${data?.servers?.length || 0} host${(data?.servers?.length || 0) === 1 ? "" : "s"} in the fleet`}
        />
        {!data?.servers?.length ? <EmptyState message="No servers" icon={Server} /> : (
          <div className="divide-y">
            {data.servers.map((s) => (
              <div key={s.id} className={rowClass}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={tileClass}><Server size={15} /></span>
                  <div className="min-w-0">
                    <a href={`#/resources/servers/${s.id}`} className="stretched-link block truncate text-sm font-medium text-fg">
                      {s.name}
                    </a>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                      {s.type && <><span className="font-mono">{s.type}</span>{sep}</>}
                      {s.location && <><span className="font-mono">{s.location}</span>{sep}</>}
                      <span>{s.replica_count} replica{s.replica_count === 1 ? "" : "s"}</span>
                      {sep}
                      {s.disk_free_gb != null && s.disk_total_gb != null ? (
                        <span
                          className={`tabular-nums ${
                            s.disk_free_gb < 2
                              ? "font-medium text-danger"
                              : s.disk_free_gb < 5
                                ? "font-medium text-warning"
                                : ""
                          }`}
                          title={`${s.disk_used_gb} / ${s.disk_total_gb} GB used`}
                        >
                          {s.disk_free_gb}/{s.disk_total_gb} GB free
                        </span>
                      ) : <span>Disk —</span>}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-sm tabular-nums text-fg">{fmtPrice(s.monthly_eur)}<span className="text-xs text-muted">/mo</span></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>}

      {/* Object storage */}
      {section === "object-storage" && <Card className="overflow-hidden">
        <CardHeader
          title="S3 buckets"
          icon={<HetznerIcon size={15} />}
          description={data?.s3_configured ? `${data?.buckets?.length || 0} bucket${(data?.buckets?.length || 0) === 1 ? "" : "s"} · Hetzner · ${data.s3_region}` : "Hetzner Object Storage"}
        />
        {!data?.s3_configured ? (
          <EmptyState icon={HetznerIcon} message="Hetzner Object Storage is not configured" description="Add S3 credentials under Settings → Hetzner & Domain." />
        ) : data.s3_error ? (
          <div className="p-4"><InlineNotice tone="danger"><span className="break-words font-mono text-xs">{data.s3_error}</span></InlineNotice></div>
        ) : (
          <>
            {!data.buckets.length ? <EmptyState message="No buckets in this region" icon={Cloud} /> : (
              <div className="divide-y">
                {data.buckets.map((bucket) => (
                  <div key={bucket.name} className={rowClass}>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className={tileClass}><Cloud size={15} /></span>
                      <div className="min-w-0">
                        <a href={`#/resources/buckets/${encodeURIComponent(bucket.name)}`} className="stretched-link block truncate text-sm font-medium text-fg">
                          {bucket.name}
                        </a>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                          <span className="font-mono">{bucket.region}</span>
                          {sep}
                          <span>Created {bucket.createdAt ? new Date(bucket.createdAt).toLocaleString() : "—"}</span>
                          {sep}
                          <span className="min-w-0 truncate font-mono" title={bucket.endpoint}>{bucket.endpoint}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>}

      {/* Volumes */}
      {section === "volumes" && (
        <Card className="overflow-hidden">
          <CardHeader
            title="Volumes"
            icon={<HardDrive size={15} />}
            description={`${data?.volumes?.length || 0} Hetzner block volume${(data?.volumes?.length || 0) === 1 ? "" : "s"}`}
          />
          <p className="border-b bg-subtle/40 px-4 py-2.5 text-xs text-muted">Hetzner block volumes only. Server-local directories share the server disk and appear under each server’s Storage and the app’s Storage.</p>
          {!data?.volumes?.length ? <EmptyState message="No Hetzner volumes" icon={HardDrive} /> : (
            <div className="divide-y">
              {data.volumes.map((v) => {
                const stateText = v.retired_state
                  ? v.retention_class === "provisional"
                    ? `provisional until ${String(v.purge_after || "").slice(0, 10)}; auto-cleanup (${v.retired_from})`
                    : `retained; review ${String(v.purge_after || "").slice(0, 10)} (${v.retired_from})`
                  : "attached";
                return (
                  <div key={v.id} className={rowClass}>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className={tileClass}><HardDrive size={15} /></span>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <a href={`#/resources/volumes/${encodeURIComponent(v.id)}`} className="stretched-link truncate text-sm font-medium text-fg">
                            {v.name}
                          </a>
                          {v.app_name && <Badge tone="info">{v.app_name}</Badge>}
                        </div>
                        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                          <span className={v.retired_state ? "text-warning" : ""}>{stateText}</span>
                          {sep}
                          <span className="tabular-nums">{v.size} GB</span>
                          {sep}
                          <span className="font-mono">{v.location}</span>
                          {sep}
                          <span>{v.server_name ? <>on <span className="font-mono">{v.server_name}</span></> : "No server"}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-sm tabular-nums text-fg">{fmtPrice(v.monthly_eur)}<span className="text-xs text-muted">/mo</span></span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}
    </PageShell>
  );
}
