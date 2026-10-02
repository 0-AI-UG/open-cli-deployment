import { useState } from "react";
import { AlertCircle, ArrowRight, Ban, CheckCircle2, ChevronRight, Circle, GitBranch, ListChecks, Loader2, MinusCircle, RefreshCw, ScrollText, Undo2, Wrench, XCircle } from "lucide-react";
import { useOperation, humanizeStep, TERMINAL_STATUSES, type OperationView } from "../hooks/useOperation.ts";
import { confirm, Btn, showToast, Badge, Card, CardHeader, PageShell, PageHeader, PageState, StatusBadge, humanize, type Tone } from "../components/ui.tsx";
import { PermissionGate } from "../components/permission-gate.tsx";
import { runCliAction, runConfirmedCliAction } from "../api/cli-actions.ts";

function fmtTs(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString();
}

function outcomeText(op: OperationView): string {
  if (op.status === "compensated") return "The operation failed. The engine finished its available cleanup or rollback steps.";
  if (op.status === "compensation_failed") return "The operation failed and cleanup or rollback is incomplete. Check the failed compensation steps before retrying.";
  if (op.status === "failed") return op.error?.finalized
    ? "An operator finalized this operation after assessing the resources. The recorded failure remains."
    : "The operation failed. Check the affected resources and steps below.";
  if (op.status === "cancelled") return "The operation was cancelled. Review the steps below to see what completed before cancellation.";
  if (op.status === "compensating") return "The operation failed and the engine is running cleanup or rollback steps.";
  return "";
}

type Step = NonNullable<ReturnType<typeof useOperation>>["steps"] extends (infer T)[] | undefined ? T : never;

function stepTone(status: string): { Icon: typeof CheckCircle2; icon: string; badge: Tone; spin?: boolean } {
  if (status === "ok") return { Icon: CheckCircle2, icon: "text-success", badge: "success" };
  if (status === "started" || status === "executing") return { Icon: Loader2, icon: "text-info", badge: "info", spin: true };
  if (status === "failed") return { Icon: XCircle, icon: "text-danger", badge: "danger" };
  if (status === "skipped") return { Icon: MinusCircle, icon: "text-muted", badge: "neutral" };
  return { Icon: Circle, icon: "text-muted", badge: "neutral" };
}

export function EngineOpDetailPage({ opId }: { opId: number }) {
  const op = useOperation(opId);
  const [actionBusy, setActionBusy] = useState<"cancel" | "retry" | "finalize" | null>(null);

  if (!op) {
    return <PageState title="Loading operation" />;
  }

  const active = !TERMINAL_STATUSES.has(op.status);
  const forward = (op.steps || []).filter((s) => s.phase === "forward");
  const compensations = (op.steps || []).filter((s) => s.phase === "compensate");
  const failedForward = forward.filter((s) => s.status === "failed");
  const failedCompensations = compensations.filter((s) => s.status === "failed");
  const failedChildren = (op.children || []).filter((child) =>
    ["failed", "compensated", "compensation_failed", "cancelled"].includes(child.status));

  async function onCancel() {
    const ok = await confirm("Cancel operation?", "The engine will stop at the next step boundary and run compensations.", true);
    if (!ok) return;
    setActionBusy("cancel");
    try {
      await runConfirmedCliAction(
        "ops.cancel",
        { operation: String(opId) },
        { action: "cancel_operation", resourceType: "operation", resourceId: opId },
      );
      showToast("Cancellation requested", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Cancellation failed", "error");
    } finally {
      setActionBusy(null);
    }
  }

  async function onRetry() {
    if (!await confirm("Retry operation?", "Resume cleanup when possible, otherwise create a fresh retry.")) return;
    setActionBusy("retry");
    try {
      await runCliAction("ops.retry", { operation: String(opId) }, { confirmed: true });
      showToast("Operation retried", "success");
      window.location.hash = "#/engine";
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Retry failed", "error");
    } finally {
      setActionBusy(null);
    }
  }

  async function onFinalize() {
    if (!await confirm("Finalize operation?", "Reconcile the affected resources and close this stale operation using the engine's automatic assessment.", true)) return;
    setActionBusy("finalize");
    try {
      await runCliAction("ops.finalize", { operation: String(opId), status: "auto" }, { confirmed: true });
      showToast("Operation finalized", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Finalize failed", "error");
    } finally {
      setActionBusy(null);
    }
  }

  const hasOutcome = !!(op.error || failedForward.length > 0 || failedCompensations.length > 0 || failedChildren.length > 0);
  const outcomeWarning = op.status === "compensating" || op.status === "cancelled";

  return (
    <PageShell>
      <PageHeader
        backHref="#/engine"
        backLabel="Back to operations"
        eyebrow={`Operation #${op.id}`}
        title={op.label || op.kind}
        meta={<>
          <StatusBadge status={op.status} />
          <span className="min-w-0 break-words">
            <span className="font-mono text-xs">{(op.resource_labels ?? op.resource_keys).join(", ")}</span> · triggered by {op.trigger}
            {op.attempt > 1 && ` · attempt ${op.attempt}`}
          </span>
        </>}
        actions={<>
        <a
          href={`#/engine/op/${op.id}/logs`}
          className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-fg shadow-xs transition-colors hover:bg-subtle max-md:h-11"
        >
          <ScrollText size={14} /> View logs
        </a>
        {["failed", "compensation_failed", "compensated", "cancelled"].includes(op.status) && (
          <PermissionGate permission="operations.cancel">
            <Btn loading={actionBusy === "retry"} disabled={actionBusy !== null} onClick={onRetry}>
              <RefreshCw size={14} /> Retry
            </Btn>
          </PermissionGate>
        )}
        {["failed", "compensation_failed"].includes(op.status) && (
          <PermissionGate permission="operations.cancel">
            <Btn variant="ghost" loading={actionBusy === "finalize"} disabled={actionBusy !== null} onClick={onFinalize}>
              <Wrench size={14} /> Finalize
            </Btn>
          </PermissionGate>
        )}
        {active && (
          <PermissionGate permission="operations.cancel">
          <Btn
            onClick={onCancel}
            loading={actionBusy === "cancel"}
            disabled={actionBusy !== null}
          >
            <Ban size={14} /> Cancel
          </Btn>
          </PermissionGate>
        )}
        </>}
      />

      <div className="frame bg-surface"><div className="cells grid grid-cols-1 min-[380px]:grid-cols-3">
        <Meta label="Enqueued" value={fmtTs(op.enqueued_at)} />
        <Meta label="Started" value={fmtTs(op.started_at)} />
        <Meta label="Finished" value={fmtTs(op.finished_at)} />
      </div></div>

      {hasOutcome && (
        <section aria-label="Operation outcome">
          <Card className={`overflow-hidden ${outcomeWarning ? "border-warning/30" : "border-danger/30"}`}>
            <CardHeader
              title="What happened"
              icon={<AlertCircle size={15} className={outcomeWarning ? "text-warning" : "text-danger"} />}
              className={outcomeWarning ? "bg-warning/5" : "bg-danger/5"}
            />
            <div className="space-y-3 p-4">
              <p className="text-sm text-fg-dim">{outcomeText(op) || "Review the failure details below."}</p>
              {op.error?.message && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Reason</div>
                  <p className="break-words rounded-md border bg-subtle/60 px-3 py-2 font-mono text-xs text-fg">{op.error.message}</p>
                </div>
              )}
              {op.error?.compensation_error && (
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Recovery</div>
                  <p className="break-words rounded-md border bg-subtle/60 px-3 py-2 font-mono text-xs text-fg">
                    {op.error.compensation_error}
                    {op.error.retries_exhausted ? <span className="font-sans text-muted"> · Automatic retries exhausted</span> : ""}
                  </p>
                </div>
              )}
              {(failedForward.length > 0 || failedCompensations.length > 0) && (
                <dl className="space-y-1 text-sm">
                  {failedForward.length > 0 && (
                    <div className="flex flex-wrap gap-x-2"><dt className="text-muted">Failed step:</dt><dd className="text-fg">{failedForward.map((s) => humanizeStep(s.step)).join(", ")}</dd></div>
                  )}
                  {failedCompensations.length > 0 && (
                    <div className="flex flex-wrap gap-x-2"><dt className="text-muted">Failed cleanup or rollback:</dt><dd className="text-fg">{failedCompensations.map((s) => humanizeStep(s.step)).join(", ")}</dd></div>
                  )}
                </dl>
              )}
              {failedChildren.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted">Affected child operations</div>
                  <div className="divide-y overflow-hidden rounded-md border">
                    {failedChildren.map((child) => (
                      <a key={child.id} href={`#/engine/op/${child.id}`} className="block break-words px-3 py-2 text-sm transition-colors hover:bg-subtle/50">
                        <span className="font-mono text-xs text-muted">#{child.id}</span>{" "}
                        <span className="font-medium text-fg">{child.label || child.kind}</span>
                        <span className="text-muted"> · <span className="font-mono text-xs">{(child.resource_labels ?? child.resource_keys).join(", ")}</span> · {child.status}</span>
                        {child.error?.message ? <span className="text-danger"> — {child.error.message}</span> : ""}
                      </a>
                    ))}
                  </div>
                </div>
              )}
              {op.error?.superseded_by && (
                <a href={`#/engine/op/${op.error.superseded_by}`} className="inline-flex items-center gap-1 text-sm text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">
                  Newer operation #{op.error.superseded_by} took ownership of these resources
                  <ArrowRight size={13} />
                </a>
              )}
            </div>
          </Card>
        </section>
      )}

      <section>
        <Card className="overflow-hidden">
          <CardHeader title="Steps" icon={<ListChecks size={15} />} description={forward.length > 0 ? `${forward.length} step${forward.length === 1 ? "" : "s"}` : undefined} />
          {forward.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">No steps yet.</div>
          ) : (
            <StepTimeline steps={forward} />
          )}
        </Card>
      </section>

      {op.children && op.children.length > 0 && (
        <section>
          <Card className="overflow-hidden">
            <CardHeader title="Child operations" icon={<GitBranch size={15} />} description={`${op.children.length} operation${op.children.length === 1 ? "" : "s"}`} />
            <div className="divide-y">
              {op.children.map((c) => (
                <a
                  key={c.id}
                  href={`#/engine/op/${c.id}`}
                  className="group block px-4 py-3 transition-colors hover:bg-subtle/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 truncate text-sm font-medium text-fg group-hover:underline">{c.label || c.kind}</span>
                        <span className="shrink-0 font-mono text-xs text-muted">#{c.id}</span>
                      </div>
                      <div className="mt-0.5 break-words font-mono text-xs text-muted">{(c.resource_labels ?? c.resource_keys).join(", ")}</div>
                    </div>
                    <StatusBadge status={c.status} />
                    <ChevronRight size={14} className="hidden shrink-0 text-muted group-hover:text-fg sm:block" />
                  </div>
                  {c.error?.message && <div className="mt-1.5 break-words font-mono text-xs text-danger">{c.error.message}</div>}
                </a>
              ))}
            </div>
          </Card>
        </section>
      )}

      {compensations.length > 0 && (
        <section>
          <Card className="overflow-hidden">
            <CardHeader title="Compensations" icon={<Undo2 size={15} />} description="Cleanup and rollback steps" />
            <StepTimeline steps={compensations} />
          </Card>
        </section>
      )}
    </PageShell>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 truncate text-sm tabular-nums text-fg">{value}</div>
    </div>
  );
}

function StepTimeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="px-4 py-2">
      {steps.map((s, i) => (
        <StepRow key={s.seq} step={s} last={i === steps.length - 1} />
      ))}
    </ol>
  );
}

function StepRow({ step, last }: { step: Step; last: boolean }) {
  const tone = stepTone(step.status);
  return (
    <li className="relative flex gap-3">
      <div className="flex w-4 shrink-0 flex-col items-center pt-3">
        <tone.Icon size={16} className={`shrink-0 bg-surface ${tone.icon} ${tone.spin ? "animate-spin" : ""}`} />
        {!last && <span className="mt-1 w-px flex-1 bg-line" />}
      </div>
      <div className="min-w-0 flex-1 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-fg">{humanizeStep(step.step)}</span>
          <Badge tone={tone.badge}>{humanize(step.status)}</Badge>
          <span className="font-mono text-xs text-muted">#{step.seq}</span>
          <span className="w-full text-xs tabular-nums text-muted sm:ml-auto sm:w-auto">
            {fmtTs(step.started_at)}
            {step.finished_at ? ` → ${fmtTs(step.finished_at)}` : ""}
          </span>
        </div>
        {step.detail && (
          <div className="mt-1 break-words font-mono text-xs text-fg-dim">{step.detail}</div>
        )}
      </div>
    </li>
  );
}
