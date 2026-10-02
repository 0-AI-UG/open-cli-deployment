import { Lock, Unlock, Plus, Minus } from "lucide-react";
import { Btn } from "./ui.tsx";

export type EnvVarRow = {
  key: string;
  value: string;
  secret: boolean;
  injected_by?: string;
};

type Props = {
  entries: EnvVarRow[];
  onChange: (entries: EnvVarRow[]) => void;
  readOnly?: boolean;
  label?: string;
};

export function EnvVarEditor({ entries, onChange, readOnly, label }: Props) {
  const update = (i: number, field: keyof EnvVarRow, val: string | boolean) => {
    const next = [...entries];
    next[i] = { ...next[i], [field]: val };
    onChange(next);
  };

  return (
    <div>
      {label && (
        <div className="mb-2 text-xs font-medium text-muted">{label}</div>
      )}
      {entries.length === 0 && !readOnly && (
        <p className="mb-2 text-sm text-muted">No environment variables.</p>
      )}
      <div className="space-y-2">
        {entries.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={v.key}
              placeholder="KEY"
              readOnly={readOnly || !!v.injected_by}
              onChange={(e) => update(i, "key", e.target.value)}
              className={`!w-1/3 font-mono ${readOnly ? "opacity-60" : ""}`}
            />
            <input
              type={v.secret ? "password" : "text"}
              value={v.value}
              placeholder={v.secret ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "value"}
              readOnly={readOnly || !!v.injected_by}
              onChange={(e) => update(i, "value", e.target.value)}
              className={`font-mono ${readOnly ? "opacity-60" : ""}`}
            />
            {v.injected_by && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded border bg-subtle px-1.5 py-0.5 text-xs text-muted" title="Managed automatically; change the source configuration to update this value.">
                <Lock size={12} />Injected · {v.injected_by}
              </span>
            )}
            {!readOnly && !v.injected_by && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const next = [...entries];
                    // When switching secret→plaintext, clear the masked value
                    // so the user re-enters it (frontend never has the real value).
                    if (v.secret) {
                      next[i] = { ...next[i], secret: false, value: "" };
                    } else {
                      next[i] = { ...next[i], secret: true };
                    }
                    onChange(next);
                  }}
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors hover:bg-subtle ${v.secret ? "text-fg" : "text-muted hover:text-fg"}`}
                  title={v.secret ? "Encrypted. Click to make plaintext (you'll need to re-enter the value)" : "Plaintext. Click to encrypt"}
                >
                  {v.secret ? <Lock size={14} /> : <Unlock size={14} />}
                </button>
                <button
                  type="button"
                  onClick={() => onChange(entries.filter((_, j) => j !== i))}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                  title="Remove variable"
                  aria-label="Remove variable"
                >
                  <Minus size={14} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {!readOnly && (
        <Btn
          size="xs"
          variant="ghost"
          className="mt-2"
          onClick={() => onChange([...entries, { key: "", value: "", secret: false }])}
        >
          <Plus size={12} /> Add variable
        </Btn>
      )}
    </div>
  );
}
