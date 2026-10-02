import { useState, useEffect } from "react";
import { get, post } from "../api/client.ts";
import { showToast, Card, Btn, AuthShell, PageState } from "../components/ui.tsx";
import { Trash2, Check, AlertTriangle, Ban } from "lucide-react";

type Item = {
  action: string;
  summary: string;
  resource_type: string;
  resource_id: string;
  resource_name?: string;
};

const ACTION_PRESENTATION: Record<string, { confirmLabel: string; destructive: boolean }> = {
  delete_app: { confirmLabel: "Confirm & Destroy", destructive: true },
  delete_server: { confirmLabel: "Confirm & Remove", destructive: true },
  delete_stack: { confirmLabel: "Confirm & Destroy", destructive: true },
  delete_environment: { confirmLabel: "Confirm & Retire", destructive: true },
  purge_environment: { confirmLabel: "Confirm & Delete", destructive: true },
  delete_volume: { confirmLabel: "Confirm & Delete", destructive: true },
  create_bucket: { confirmLabel: "Confirm & Create", destructive: false },
  delete_bucket: { confirmLabel: "Confirm & Delete", destructive: true },
  cancel_operation: { confirmLabel: "Confirm & Cancel", destructive: true },
  create_server: { confirmLabel: "Confirm & Create", destructive: false },
  promote_app: { confirmLabel: "Confirm & Promote", destructive: false },
  promote_stack: { confirmLabel: "Confirm & Promote", destructive: false },
};

export function CliConfirmPage({ userCode }: { userCode: string }) {
  const [item, setItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "confirm" | "deny">(null);
  const [done, setDone] = useState<null | "confirmed" | "denied">(null);
  const [typedResource, setTypedResource] = useState("");

  useEffect(() => {
    get(`/api/confirmations/item/${encodeURIComponent(userCode)}`)
      .then((res: Item) => setItem(res))
      .catch(() => setError("This confirmation link is invalid or has expired."));
  }, [userCode]);

  const handleConfirm = async () => {
    setSubmitting("confirm");
    try {
      await post(
        `/api/confirmations/item/${encodeURIComponent(userCode)}/confirm`,
        item?.action === "delete_volume"
          ? { typed_resource_id: typedResource.trim() }
          : item?.action === "purge_environment" || item?.action === "delete_bucket"
            ? { typed_resource_name: typedResource.trim() }
          : undefined,
      );
      setDone("confirmed");
    } catch (err: any) {
      showToast(err.message || "Failed to confirm action", "error");
    } finally {
      setSubmitting(null);
    }
  };

  const handleDeny = async () => {
    setSubmitting("deny");
    try {
      await post(`/api/confirmations/item/${encodeURIComponent(userCode)}/deny`);
      setDone("denied");
    } catch (err: any) {
      showToast(err.message || "Failed to cancel action", "error");
    } finally {
      setSubmitting(null);
    }
  };

  // --- done: confirmed ---
  if (done === "confirmed") {
    return (
      <AuthShell title="Action confirmed" description="You can close this page and return to your terminal.">
        <Card className="flex justify-center p-6">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-success/10 text-success">
            <Check size={22} />
          </span>
        </Card>
      </AuthShell>
    );
  }

  // --- done: denied ---
  if (done === "denied") {
    return (
      <AuthShell title="Action cancelled" description="The action was cancelled. You can close this page.">
        <Card className="flex justify-center p-6">
          <span className="grid h-12 w-12 place-items-center rounded-full border bg-subtle text-muted">
            <Ban size={22} />
          </span>
        </Card>
      </AuthShell>
    );
  }

  // --- error ---
  if (error) {
    return (
      <AuthShell title="Confirmation unavailable">
        <Card className="flex flex-col items-center gap-3 border-danger/30 p-6 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-danger/10 text-danger">
            <AlertTriangle size={22} />
          </span>
          <p className="text-sm text-fg-dim">{error}</p>
        </Card>
      </AuthShell>
    );
  }

  // --- loading ---
  if (!item) {
    return <PageState title="Loading confirmation" />;
  }

  // --- loaded (pending) ---
  const requiredTypedResource = item.action === "delete_volume"
    ? item.resource_id
    : item.action === "purge_environment" || item.action === "delete_bucket"
      ? item.resource_name
      : undefined;
  const typedResourceMatches = requiredTypedResource === undefined || typedResource.trim() === requiredTypedResource;
  const presentation = ACTION_PRESENTATION[item.action] ?? {
    confirmLabel: "Confirm action",
    destructive: false,
  };
  const ConfirmationIcon = presentation.destructive ? Trash2 : Check;

  return (
    <AuthShell title="Confirm action" width="md">
      <Card className={`space-y-5 p-6 ${presentation.destructive ? "border-danger/30" : ""}`}>
        <div className="flex items-start gap-3">
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${presentation.destructive ? "bg-danger/10 text-danger" : "border bg-subtle text-muted"}`}>
            <ConfirmationIcon size={16} />
          </span>
          <p className="text-sm text-fg-dim">
            A CLI command is requesting confirmation{presentation.destructive ? " for a destructive action" : ""}. Review the details below before continuing.
          </p>
        </div>
        <div className="break-words rounded-lg border bg-subtle/60 p-3 font-mono text-xs text-fg">
          {item.summary}
        </div>
        {requiredTypedResource !== undefined && (
          <div className="space-y-1.5">
            <label className="block text-sm text-fg-dim" htmlFor="resource-confirmation">
              Type {item.action === "delete_volume" ? "volume ID" : item.action === "delete_bucket" ? "bucket name" : "environment name"}{" "}
              <code className="select-all rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">{requiredTypedResource}</code> to permanently delete it
            </label>
            <input
              id="resource-confirmation"
              type="text"
              value={typedResource}
              onChange={(event) => setTypedResource(event.target.value)}
              autoComplete="off"
              className="font-mono"
            />
          </div>
        )}
        <div className="space-y-2">
          <Btn
            type="button"
            onClick={handleConfirm}
            variant={presentation.destructive ? "danger" : "primary"}
            size="md"
            loading={submitting === "confirm"}
            disabled={submitting !== null || !typedResourceMatches}
            className="w-full"
          >
            {presentation.confirmLabel}
          </Btn>
          <Btn
            type="button"
            onClick={handleDeny}
            variant="default"
            size="md"
            loading={submitting === "deny"}
            disabled={submitting !== null}
            className="w-full"
          >
            Cancel
          </Btn>
        </div>
      </Card>
    </AuthShell>
  );
}
