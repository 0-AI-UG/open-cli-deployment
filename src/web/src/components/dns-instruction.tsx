import { Globe } from "lucide-react";
import { Badge, CopyButton, type Tone } from "./ui.tsx";
import type { DnsInstruction } from "../types.ts";

const TONES: Record<DnsInstruction["status"], Tone> = {
  correct: "success",
  pending: "warning",
  conflicting: "danger",
  not_applicable: "neutral",
};

export function DnsInstructionView({ value }: { value?: DnsInstruction | null }) {
  if (!value) return null;
  const label = value.status.replace("_", " ");
  return (
    <div className="space-y-3 rounded-lg border bg-canvas/50 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          <Globe size={14} className="text-muted" />
          DNS instruction
        </span>
        <Badge tone={TONES[value.status]}>{label.charAt(0).toUpperCase() + label.slice(1)}</Badge>
      </div>
      {value.record ? (
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md border bg-surface px-3 py-2">
          <span className="text-xs text-muted">Type</span>
          <code className="font-mono text-xs text-fg">{value.record.type}</code>
          <CopyButton text={value.record.type} />
          <span className="text-xs text-muted">Name</span>
          <code className="break-all font-mono text-xs text-fg">{value.record.name}</code>
          <CopyButton text={value.record.name} />
          <span className="text-xs text-muted">Value</span>
          <code className="break-all font-mono text-xs text-fg">{value.record.value}</code>
          <CopyButton text={value.record.value} />
        </div>
      ) : null}
      <p className="text-sm leading-relaxed text-fg-dim">{value.message}</p>
      {value.observedValues.length > 0 && value.status !== "correct" ? (
        <p className="text-xs text-danger">Observed: <span className="font-mono">{value.observedValues.join(", ")}</span></p>
      ) : null}
    </div>
  );
}
