import { ShieldAlert } from "lucide-react";
import { Card } from "./ui.tsx";

export function PasskeyUnsupported({ onBack }: { onBack?: () => void }) {
  return (
    <>
      <Card className="flex flex-col items-center p-6 text-center">
        <span className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-warning/10 text-warning">
          <ShieldAlert size={22} />
        </span>
        <p className="text-sm font-medium text-fg">Passkeys are required</p>
        <p className="mt-1.5 text-sm text-fg-dim">
          This browser does not support passkeys. Open the panel in a modern browser
          (Chrome, Safari, Edge, or Firefox) on a device with biometric unlock or a
          security key.
        </p>
      </Card>
      {onBack && (
        <p className="mt-4 text-center text-xs text-muted">
          <button type="button" onClick={onBack} className="transition-colors hover:text-fg">
            Back to sign in
          </button>
        </p>
      )}
    </>
  );
}
