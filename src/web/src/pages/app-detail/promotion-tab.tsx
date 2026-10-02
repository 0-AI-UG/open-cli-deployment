import { useEffect, useState } from "react";
import { get } from "../../api/client.ts";
import { Card, CardHeader, DataRow, EmptyState, Btn, StatusBadge, confirm, showToast } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { ArrowUpCircle, ExternalLink, Rocket } from "lucide-react";
import type { AppData } from "../../types.ts";
import type { AppStagingResponse } from "../../../../shared/rpc.ts";
import { runConfirmedCliAction } from "../../api/cli-actions.ts";

const errMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface PromotionTabProps {
  app: AppData;
  appId: number;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function PromotionTab({ app, appId, action, ops }: PromotionTabProps) {
  const [staging, setStaging] = useState<AppStagingResponse | null>(null);

  const load = async () => {
    try {
      setStaging(await get(`/api/apps/${appId}/staging`));
    } catch (error) {
      showToast(errMessage(error), "error");
    }
  };

  useEffect(() => { load(); }, [appId]);

  const sibling = staging?.sibling ?? null;
  const canPromote = sibling?.status === "running";

  const promote = async () => {
    if (!sibling) return;
    if (!await confirm(
      "Promote to production",
      `Promote the exact immutable image running in ${sibling.name} to ${app.name}?`,
    )) return;

    await action("promote", async () => {
      await runConfirmedCliAction(
        "app.promote",
        { from: String(sibling.id), to: String(appId) },
        { action: "promote_app", resourceType: "promotion", resourceId: `${sibling.id}:${appId}` },
      );
    });
    await load();
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Staging promotion"
        icon={<Rocket size={15} />}
        description="Ship the exact image running in staging to this app"
        actions={sibling && <>
          <StatusBadge status={sibling.status} />
          <a href={`#/apps/${sibling.id}`} className="inline-flex items-center gap-1 rounded text-sm font-medium text-fg-dim transition-colors hover:text-fg">
            Open <ExternalLink size={12} />
          </a>
        </>}
      />
      {!sibling ? (
        <EmptyState message="No staging sibling is connected to this app." icon={Rocket} className="!py-10" />
      ) : (
        <>
          <div>
            <DataRow label="Source app">
              <a href={`#/apps/${sibling.id}`} className="font-medium text-fg hover:underline">{sibling.name}</a>
            </DataRow>
            {sibling.domain && (
              <DataRow label="Staging URL">
                <a href={`https://${sibling.domain}`} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-fg hover:underline">
                  <span className="truncate font-mono text-xs">{sibling.domain}</span>
                  <ExternalLink size={11} className="shrink-0 text-muted" />
                </a>
              </DataRow>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-subtle/40 px-4 py-3">
            <p className="text-sm text-muted">
              {canPromote ? "Production receives the staging image digest unchanged." : "The staging app must be running before it can be promoted."}
            </p>
            <PermissionGate permission="apps.promote" appId={appId} environmentId={app.environment_id}>
              <Btn variant="primary" disabled={ops.isBusy || !canPromote} loading={ops.isBusyWith("promote")} onClick={promote}>
                <ArrowUpCircle size={14} /> Promote exact image
              </Btn>
            </PermissionGate>
          </div>
        </>
      )}
    </Card>
  );
}
