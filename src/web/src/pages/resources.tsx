import { useState, useEffect, useRef } from "react";
import { get } from "../api/client.ts";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";
import { Badge, Card, CardHeader, Btn, Table, EmptyState, InfoTip, InlineNotice, SectionHeader, Stat, StatusBadge, showToast, confirm, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { useActiveOperations } from "../hooks/useOperation.ts";
import { PermissionGate } from "../components/permission-gate.tsx";
import { NeoSelect } from "../components/neo-select.tsx";
import { useServerTypes, typeOptions, locationOptions } from "../hooks/use-server-types.ts";
import { ArrowRight, HardDrive, Server, Trash2, RefreshCw, Plus, History, Cloud, Hammer } from "lucide-react";
import { HetznerIcon } from "../components/brand-icons";
import type { ResourcesData } from "../types.ts";
import { serverProvisioningResourceId } from "../../../shared/server-provisioning.ts";
import { InfrastructureTools } from "../components/infrastructure-tools.tsx";
import { TabBar } from "../components/tab-bar.tsx";
import { useHashParam } from "../hooks/use-hash-param.ts";

type ResourceSection = "overview" | "servers" | "volumes" | "object-storage" | "tools";

const RESOURCE_SECTIONS: Array<{ key: ResourceSection; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "servers", label: "Servers" },
  { key: "volumes", label: "Volumes" },
  { key: "object-storage", label: "Object Storage" },
  { key: "tools", label: "Tools" },
];

export function ResourcesPage() {
  const [section, setSection] = useHashParam("section", RESOURCE_SECTIONS.map((item) => item.key), "overview");
  const [data, setData] = useState<ResourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [volumeAudit, setVolumeAudit] = useState<Array<{
    id: number; requested_at: string; provider_volume_id: string; provider_volume_name: string;
    former_resource_name: string; status: string; actor_user_id: string; error: string;
  }> | null>(null);

  // Create server form state
  const [createType, setCreateType] = useState("");
  const [createLocation, setCreateLocation] = useState("");
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createProgress, setCreateProgress] = useState("");
  const { serverTypes } = useServerTypes();
  const aliveRef = useRef(true);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [bucketName, setBucketName] = useState("");
  const [bucketBusy, setBucketBusy] = useState<string | null>(null);

  const ops = useActiveOperations(
    (op) => op.kind === "provision_server" || op.kind === "destroy_server",
    { rehydrateToasts: true },
  );

  const togglePopover = () => setShowCreate((v) => !v);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!showCreate) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (popoverRef.current && !popoverRef.current.contains(target) && !target.closest("[data-neoselect-menu]")) {
        setShowCreate(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showCreate]);

  const handleCreateServer = async () => {
    if (!createType || !createLocation) {
      showToast("Select server type and location", "error");
      return;
    }
    if (!await confirm(
      "Create Server",
      `Create a billable ${createType} server in ${createLocation}${createName ? ` named "${createName}"` : ""}?`,
      true,
    )) return;
    setCreating(true);
    try {
      const planId = serverProvisioningResourceId({
        serverType: createType,
        location: createLocation,
        reason: createName ? `server ${createName}` : "an explicitly requested server",
      });
      await runConfirmedCliAction(
        "servers.create",
        { type: createType, location: createLocation, name: createName || undefined },
        { action: "create_server", resourceType: "server_plan", resourceId: planId },
      );
      showToast("Server provisioned", "success");
      setShowCreate(false);
      setCreateType("");
      setCreateLocation("");
      setCreateName("");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setCreating(false);
      setCreateProgress("");
    }
  };

  const load = async () => {
    try {
      const resources = await get("/api/resources");
      setData(resources);
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (type: string, id: string, name: string) => {
    if (!await confirm("Delete Resource", `Delete ${type.replace("_", " ")} "${name}"? This cannot be undone.`, true)) return;
    let typedVolumeId: string | undefined;
    if (type === "volume") {
      typedVolumeId = window.prompt(`Type the Hetzner volume ID "${id}" to permanently delete its data:`)?.trim();
      if (typedVolumeId !== id) {
        showToast("Volume ID did not match; deletion cancelled", "error");
        return;
      }
    }
    const key = `${type}-${id}`;
    setDeleting(key);
    try {
      if (type === "volume") {
        await runConfirmedCliAction(
          "volumes.delete",
          { volume: id },
          { action: "delete_volume", resourceType: "volume", resourceId: id, typedResource: typedVolumeId },
        );
      } else {
        await runConfirmedCliAction(
          "servers.delete",
          { server: id },
          { action: "delete_server", resourceType: "server", resourceId: id },
        );
      }
      showToast(`${name} deleted`, "success");
      load();
    } catch (err: any) {
      showToast(err.message, "error");
    } finally {
      setDeleting(null);
    }
  };

  const toggleVolumeAudit = async () => {
    if (volumeAudit) {
      setVolumeAudit(null);
      return;
    }
    try {
      setVolumeAudit(await get("/api/resources/volumes/deletion-audit"));
    } catch (err: any) {
      showToast(err.message || "Failed to load deletion audit", "error");
    }
  };

  const handleCreateBucket = async () => {
    const name = bucketName.trim().toLowerCase();
    if (!name) return showToast("Enter a bucket name", "error");
    if (!await confirm("Create S3 Bucket", `Create private bucket "${name}" in ${data?.s3_region || "the configured region"}? Hetzner billing starts when the first bucket becomes active.`, true)) return;
    setBucketBusy(`create:${name}`);
    try {
      await runConfirmedCliAction(
        "buckets.create",
        { bucket: name },
        { action: "create_bucket", resourceType: "bucket", resourceId: name },
      );
      setBucketName("");
      await load();
      showToast("Bucket created", "success");
    } catch (err: any) {
      showToast(err.message || "Bucket creation failed", "error");
    } finally {
      setBucketBusy(null);
    }
  };

  const handleDeleteBucket = async (name: string) => {
    if (!await confirm("Delete S3 Bucket", `Delete empty bucket "${name}"? OCD will never recursively delete its objects or versions.`, true)) return;
    const typed = window.prompt(`Type the bucket name "${name}" to confirm deletion:`)?.trim();
    if (typed !== name) return showToast("Bucket name did not match; deletion cancelled", "error");
    setBucketBusy(`delete:${name}`);
    try {
      await runConfirmedCliAction(
        "buckets.delete",
        { bucket: name },
        { action: "delete_bucket", resourceType: "bucket", resourceId: name, typedResource: typed },
      );
      await load();
      showToast("Bucket deleted", "success");
    } catch (err: any) {
      showToast(err.message || "Bucket deletion failed", "error");
    } finally {
      setBucketBusy(null);
    }
  };

  const fmtPrice = (eur: number | null | undefined) => {
    if (eur == null) return "—";
    return `€${eur.toFixed(2)}`;
  };

  if (loading) return <PageState title="Loading resources" />;

  const rowClass = "flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-subtle/50";
  const tileClass = "grid h-8 w-8 shrink-0 place-items-center rounded-md border bg-subtle text-muted";
  const sep = <span className="text-line-strong">·</span>;

  return (
    <PageShell>
      <PageHeader title="Resources" description="Servers, volumes, S3 buckets, capacity, and infrastructure cost." actions={<Btn onClick={async () => {
          setLoading(true);
          try {
            await runCliAction("servers.refresh");
            await load();
            showToast("Hetzner inventory refreshed", "success");
          } catch (error) {
            showToast(error instanceof Error ? error.message : "Refresh failed", "error");
            setLoading(false);
          }
        }}><RefreshCw size={14} /> Refresh inventory</Btn>} />

      <TabBar tabs={RESOURCE_SECTIONS} active={section} onChange={setSection} />

      {/* Cost estimate */}
      {section === "overview" && data?.totals && (
        <section className="space-y-3">
          <SectionHeader
            title={<span className="inline-flex items-center gap-1">Estimated monthly cost <InfoTip text="Estimates based on Hetzner's list prices. Excludes traffic overage and snapshots." /></span>}
            actions={<span className="text-xs text-muted">Gross · {data.totals.currency || "EUR"}</span>}
          />
          <div className="frame bg-surface"><div className="cells grid grid-cols-1 sm:grid-cols-3">
            <Stat label="Servers" value={fmtPrice(data.totals.servers)} className="bg-surface px-4 py-3.5" />
            <Stat label="Volumes" value={fmtPrice(data.totals.volumes)} className="bg-surface px-4 py-3.5" />
            <Stat label="Total / month" value={fmtPrice(data.totals.total)} hint="Servers + volumes" className="bg-subtle px-4 py-3.5" />
          </div></div>
        </section>
      )}

      {section === "overview" && (
        <section className="space-y-3">
          <SectionHeader title="Inventory" />
          <div className="frame bg-surface"><div className="cells grid sm:grid-cols-2">
            {[
              { key: "servers" as const, label: "Servers", value: data?.servers?.length || 0, unit: "hosts", icon: Server },
              { key: "volumes" as const, label: "Volumes", value: data?.volumes?.length || 0, unit: "volumes", icon: HardDrive },
              {
                key: "object-storage" as const,
                label: "Object Storage",
                value: data?.s3_configured ? data.buckets?.length || 0 : "—", unit: data?.s3_configured ? "buckets" : "Not configured", icon: Cloud,
              },
              { key: "tools" as const, label: "Tools", value: "↗", unit: "Workers · cleanup", icon: Hammer },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
                className="group flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-brand/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
              >
                <item.icon size={20} className="shrink-0 text-muted transition-colors group-hover:text-fg" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{item.label}</span>
                  <span className="mt-0.5 flex items-baseline gap-1.5">
                    <strong className="text-xl font-semibold tabular-nums tracking-tight text-fg">{item.value}</strong>
                    <span className="truncate text-xs text-muted">{item.unit}</span>
                  </span>
                </span>
                <ArrowRight size={15} className="shrink-0 text-muted transition-colors group-hover:text-fg" />
              </button>
            ))}
          </div></div>
        </section>
      )}

      {/* Servers */}
      {section === "servers" && <Card className="overflow-hidden">
        <CardHeader
          title="Servers"
          icon={<Server size={15} />}
          description={`${data?.servers?.length || 0} host${(data?.servers?.length || 0) === 1 ? "" : "s"} in the fleet`}
          actions={
            <div className="relative" ref={popoverRef}>
              <PermissionGate permission="servers.create">
                <Btn size="xs" onClick={creating ? undefined : togglePopover}>
                  <Plus size={13} /> Create server
                </Btn>
              </PermissionGate>
              {showCreate && (
                <div className="absolute right-0 top-full z-50 mt-1.5 w-64 animate-pop-in space-y-2 bg-surface p-3 rounded-lg shadow-pop">
                  <div className="pb-1 text-xs font-medium text-muted">New Hetzner server</div>
                  <NeoSelect
                    value={createType}
                    options={typeOptions(serverTypes)}
                    onChange={(v) => { setCreateType(v); setCreateLocation(""); }}
                    placeholder="Type..."
                    compact
                  />
                  <NeoSelect
                    value={createLocation}
                    options={locationOptions(serverTypes, createType)}
                    onChange={setCreateLocation}
                    placeholder="Location..."
                    compact
                    disabled={!createType}
                  />
                  <input
                    type="text"
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Name (optional)"
                    className="w-full font-mono"
                  />
                  <Btn size="xs" variant="primary" onClick={handleCreateServer} disabled={creating || ops.isBusyWith("provision_server") || !createType || !createLocation} className="w-full">
                    {ops.isBusyWith("provision_server") ? "Provisioning…" : (creating && createProgress ? createProgress : "Create")}
                  </Btn>
                </div>
              )}
            </div>
          }
        />
        {!data?.servers?.length ? <EmptyState message="No servers" icon={Server} /> : (
          <div className="divide-y">
            {data.servers.map((s) => (
              <div key={s.id} className={rowClass}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className={tileClass}><Server size={15} /></span>
                  <div className="min-w-0">
                    <a href={`#/resources/servers/${s.id}`} className="block truncate text-sm font-medium text-fg hover:underline">
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
                  <PermissionGate permission="resources.delete">
                    <Btn
                      variant="ghost"
                      disabled={s.replica_count > 0}
                      title={s.replica_count > 0 ? "In use by replicas" : `Delete ${s.name}`}
                      loading={deleting === `server-${s.id}` || !!ops.byResourceKey(`server:${s.id}`)}
                      onClick={() => handleDelete("server", String(s.id), s.name)}
                    >
                      <Trash2 size={15} />
                    </Btn>
                  </PermissionGate>
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
          <EmptyState icon={HetznerIcon} message="Hetzner Object Storage is not configured" description="Add S3 credentials under Admin → Hetzner." />
        ) : data.s3_error ? (
          <div className="p-4"><InlineNotice tone="danger"><span className="break-words font-mono text-xs">{data.s3_error}</span></InlineNotice></div>
        ) : (
          <>
            <PermissionGate permission="buckets.create">
              <div className="flex flex-col gap-2 border-b bg-subtle/40 px-4 py-3 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={bucketName}
                  onChange={(event) => setBucketName(event.target.value)}
                  placeholder="globally-unique-bucket-name"
                  className="min-w-0 flex-1 font-mono"
                />
                <Btn onClick={handleCreateBucket} loading={bucketBusy?.startsWith("create:") === true} disabled={!bucketName.trim()}>
                  <Plus size={14} /> Create private bucket
                </Btn>
              </div>
            </PermissionGate>
            {!data.buckets.length ? <EmptyState message="No buckets in this region" icon={Cloud} /> : (
              <div className="divide-y">
                {data.buckets.map((bucket) => (
                  <div key={bucket.name} className={rowClass}>
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span className={tileClass}><Cloud size={15} /></span>
                      <div className="min-w-0">
                        <a href={`#/resources/buckets/${encodeURIComponent(bucket.name)}`} className="block truncate text-sm font-medium text-fg hover:underline">
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
                    <PermissionGate permission="buckets.delete">
                      <Btn variant="ghost" title={`Delete ${bucket.name}`} loading={bucketBusy === `delete:${bucket.name}`} onClick={() => handleDeleteBucket(bucket.name)}>
                        <Trash2 size={15} />
                      </Btn>
                    </PermissionGate>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>}

      {/* Volumes */}
      {section === "volumes" && <>
        <Card className="overflow-hidden">
          <CardHeader
            title="Volumes"
            icon={<HardDrive size={15} />}
            description={`${data?.volumes?.length || 0} Hetzner block volume${(data?.volumes?.length || 0) === 1 ? "" : "s"}`}
            actions={
              <PermissionGate permission="volumes.delete">
                <Btn size="xs" variant="ghost" onClick={toggleVolumeAudit}>
                  <History size={13} /> {volumeAudit ? "Hide audit" : "Deletion audit"}
                </Btn>
              </PermissionGate>
            }
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
                          <a href={`#/resources/volumes/${encodeURIComponent(v.id)}`} className="truncate text-sm font-medium text-fg hover:underline">
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
                      <PermissionGate permission="volumes.delete">
                        <Btn variant="ghost" disabled={!!v.app_name} title={v.app_name ? `In use by ${v.app_name}` : `Delete ${v.name}`} loading={deleting === `volume-${v.id}`} onClick={() => handleDelete("volume", v.id, v.name)}>
                          <Trash2 size={15} />
                        </Btn>
                      </PermissionGate>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        {volumeAudit && (
          <Card className="overflow-hidden">
            <CardHeader title="Permanent deletion audit" icon={<History size={15} />} description="Every attempt to permanently delete volume data" />
            {volumeAudit.length === 0 ? (
              <EmptyState message="No deletion attempts recorded." icon={History} />
            ) : (
              <Table headers={["Requested", "Volume", "Former owner", "Status", "Actor", "Error"]}>
                {volumeAudit.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap text-fg-dim">{row.requested_at}</td>
                    <td><span className="font-medium text-fg">{row.provider_volume_name}</span> <span className="font-mono text-xs text-muted">#{row.provider_volume_id}</span></td>
                    <td className="text-fg-dim">{row.former_resource_name || "—"}</td>
                    <td><StatusBadge status={row.status} /></td>
                    <td className="font-mono text-xs text-fg-dim">{row.actor_user_id}</td>
                    <td className={row.error ? "text-danger" : "text-muted"}>{row.error || "—"}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}
      </>}

      {section === "tools" && <InfrastructureTools />}
    </PageShell>
  );
}
