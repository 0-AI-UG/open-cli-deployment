import type { ReactNode } from "react";
import { Pause } from "lucide-react";

export function PausedBanner({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-warning/10 text-warning">
        <Pause size={14} />
      </span>
      <span className="min-w-0 flex-1 text-sm text-fg-dim">
        {message}
      </span>
      {children && <div className="ml-auto shrink-0">{children}</div>}
    </div>
  );
}
