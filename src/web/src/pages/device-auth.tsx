import { useState, useRef, useEffect } from "react";
import { post } from "../api/client.ts";
import { showToast, Card, Btn, AuthShell } from "../components/ui.tsx";
import { Terminal, Check } from "lucide-react";

export function DeviceAuthPage() {
  const [code, setCode] = useState(["", "", "", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const fullCode = code.slice(0, 4).join("") + "-" + code.slice(4).join("");
  const isComplete = code.every((c) => c !== "");

  const handleInput = (index: number, value: string) => {
    const char = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-1);
    const next = [...code];
    next[index] = char;
    setCode(next);

    if (char && index < 7) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const chars = text.slice(0, 8).split("");
    const next = [...code];
    chars.forEach((ch, i) => { next[i] = ch; });
    setCode(next);
    const focusIdx = Math.min(chars.length, 7);
    inputRefs.current[focusIdx]?.focus();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isComplete) return;
    setLoading(true);
    try {
      await post("/api/auth/device-confirm", { user_code: fullCode });
      setConfirmed(true);
    } catch (err: any) {
      showToast(err.message || "Invalid or expired code", "error");
    } finally {
      setLoading(false);
    }
  };

  if (confirmed) {
    return (
      <AuthShell title="CLI authorized" description="You can close this page and return to your terminal.">
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-success/10 text-success">
            <Check size={22} />
          </span>
          <p className="text-sm text-fg-dim">Your CLI session is now signed in.</p>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="CLI login" description="Enter the code shown in your terminal to authorize the CLI." width="md">
      <Card className="p-4 sm:p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="flex items-center justify-center gap-1 sm:gap-1.5" onPaste={handlePaste}>
            {code.map((char, i) => (
              <span key={i} className="contents">
                {i === 4 && <span aria-hidden="true" className="mx-0.5 font-mono text-lg text-muted sm:mx-1">–</span>}
                <input
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type="text"
                  inputMode="text"
                  maxLength={1}
                  aria-label={`Code character ${i + 1}`}
                  value={char}
                  onChange={(e) => handleInput(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  className="!h-11 !w-8 !px-0 text-center font-mono !text-lg font-semibold sm:!h-12 sm:!w-10"
                />
              </span>
            ))}
          </div>
          <Btn
            type="submit"
            variant="primary"
            size="md"
            loading={loading}
            disabled={!isComplete}
            className="w-full"
          >
            <Terminal size={14} /> Authorize CLI
          </Btn>
        </form>
      </Card>
    </AuthShell>
  );
}
