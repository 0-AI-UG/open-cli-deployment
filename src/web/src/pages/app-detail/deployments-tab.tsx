import { useState } from "react";
import { runCliAction } from "../../api/cli-actions.ts";
import { Badge, Card, CardHeader, Btn, EmptyState, StatusBadge, Table, CopyButton, confirm, showToast, humanize } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { Clock, History, RefreshCw, Rocket, RotateCcw, Upload } from "lucide-react";
import type { DeploymentRecord } from "../../types.ts";

interface DeploymentsTabProps {
  appId: number;
  deployments: DeploymentRecord[];
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function DeploymentsTab({ appId, deployments, action, ops }: DeploymentsTabProps) {
  const [image, setImage] = useState("");
  const [commit, setCommit] = useState("");
  const [showRelease, setShowRelease] = useState(false);

  const release = async () => {
    if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/i.test(image.trim())) {
      showToast("Use an immutable repository@sha256 digest", "error");
      return;
    }
    if (commit && !/^[a-f0-9]{7,64}$/i.test(commit)) {
      showToast("Commit must be 7-64 hexadecimal characters", "error");
      return;
    }
    await action("release", () => runCliAction("app.release", { app: String(appId), image: image.trim(), commit: commit || undefined }));
    setShowRelease(false);
    setImage("");
    setCommit("");
  };

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Delivery actions"
          icon={<Rocket size={15} />}
          description="Recreate the stored artifact or release a new immutable digest through the OCD CLI."
          className="flex-wrap"
          actions={<div className="flex flex-wrap gap-2">
            <PermissionGate permission="apps.deploy" appId={appId}>
              <Btn size="xs" disabled={ops.isBusy} onClick={() => action("redeploy", () => runCliAction("app.redeploy", { app: String(appId) }))}><RefreshCw size={12} /> Redeploy current</Btn>
            </PermissionGate>
            <PermissionGate permission="apps.restart" appId={appId}>
              <Btn size="xs" disabled={ops.isBusy} onClick={async () => {
                if (await confirm("Reload environment", "Recreate this app from its current immutable image using the latest linked environment values?", true)) {
                  await action("reload environment", () => runCliAction("app.reload-env", { app: String(appId) }, { confirmed: true }));
                }
              }}><RotateCcw size={12} /> Reload environment</Btn>
            </PermissionGate>
            <PermissionGate permission="apps.deploy" appId={appId}>
              <Btn size="xs" variant="primary" onClick={() => setShowRelease((open) => !open)}><Upload size={12} /> Release digest</Btn>
            </PermissionGate>
          </div>}
        />
        {showRelease && <div className="grid gap-2 bg-subtle/40 px-4 py-3 md:grid-cols-[1fr_200px_auto]">
          <input className="font-mono" value={image} onChange={(event) => setImage(event.target.value)} placeholder="registry.example.com/team/app@sha256:…" />
          <input className="font-mono" value={commit} onChange={(event) => setCommit(event.target.value.trim())} placeholder="Source commit (optional)" />
          <Btn variant="primary" disabled={ops.isBusy || !image.trim()} onClick={release}>Release</Btn>
        </div>}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Deployment history"
          icon={<Clock size={15} />}
          description={deployments.length > 0 ? `${deployments.length} deployment${deployments.length === 1 ? "" : "s"}` : undefined}
        />
        {deployments.length === 0 ? (
          <EmptyState message="No deployments yet" icon={Clock} className="!py-10" />
        ) : (
          <Table headers={["ID", "Image", "Digest", "Commit", "Config", "Source", "Status", "Date", ""]}>
            {deployments.map((d) => (
              <tr key={d.id}>
                <td className="font-mono text-xs font-medium text-fg">#{d.id}</td>
                <td className="max-w-[200px] truncate font-mono text-xs text-fg-dim" title={d.image_tag}>{d.image_tag}</td>
                <td className="font-mono text-xs text-fg-dim" title={d.image_digest}>
                  {d.image_digest ? d.image_digest.split("@sha256:").pop()?.slice(0, 12) : "—"}
                </td>
                <td className="font-mono text-xs text-fg-dim">{d.git_commit?.slice(0, 7) || "—"}</td>
                <td className="font-mono text-xs text-fg-dim">r{d.config_revision ?? 1}</td>
                <td><Badge>{humanize(d.source || "manual")}</Badge></td>
                <td><StatusBadge status={d.status} /></td>
                <td className="whitespace-nowrap text-xs text-muted">{new Date(d.created_at + "Z").toLocaleString()}</td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {d.status === "failed" && d.deploy_log && (
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="max-w-[220px] truncate font-mono text-xs text-danger" title={d.deploy_log}>{d.deploy_log}</span>
                        <CopyButton text={d.deploy_log} size={12} />
                      </span>
                    )}
                    {d.status !== "failed" && (
                      <PermissionGate permission="apps.rollback" appId={appId}>
                        <Btn
                          size="xs" variant="ghost"
                          disabled={ops.isBusy}
                          loading={ops.isBusyWith("rollback")}
                          onClick={async () => {
                            if (await confirm("Rollback", `Rollback to deployment #${d.id}?`)) {
                              action("rollback", () => runCliAction("app.rollback", {
                                app: String(appId),
                                deployment: String(d.id),
                              }));
                            }
                          }}
                        ><History size={12} /> Rollback</Btn>
                      </PermissionGate>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
