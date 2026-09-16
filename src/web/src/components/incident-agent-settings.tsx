import { useEffect, useState } from "react";
import { KeyRound, Save } from "lucide-react";
import { get, put } from "../api/client.ts";
import { Btn, Card, showToast } from "./ui.tsx";

export function IncidentAgentSettings() {
  const [key, setKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [fromEnv, setFromEnv] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get("/api/admin/settings").then(data => { setConfigured(!!data.deepseek_api_key || !!data.deepseek_api_key_from_env); setFromEnv(!!data.deepseek_api_key_from_env); }).catch(() => {}); }, []);
  const save = async () => {
    setBusy(true);
    try { await put("/api/admin/settings", { deepseek_api_key: key }); setConfigured(!!key || fromEnv); setKey(""); showToast("Incident agent key saved", "success"); }
    catch (error) { showToast(error instanceof Error ? error.message : "Could not save key", "error"); }
    finally { setBusy(false); }
  };
  return <Card className="p-5 space-y-3"><div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase"><KeyRound size={13} /> Incident agent</div><p className="font-mono text-[10px] text-muted">DeepSeek powers outage investigation and repair. Its API key stays on the panel server.</p><div className="font-mono text-[10px]">{fromEnv ? "Configured with DEEPSEEK_API_KEY" : configured ? "API key configured" : "No API key configured"}</div>{!fromEnv && <div className="flex flex-col gap-2 sm:flex-row"><input type="password" autoComplete="off" className="min-h-11 flex-1 border-2 border-fg bg-bg px-3 font-mono text-xs" placeholder={configured ? "Enter a new key to replace" : "DeepSeek API key"} value={key} onChange={event => setKey(event.target.value)} /><Btn variant="primary" disabled={!key || busy} loading={busy} onClick={() => void save()}><Save size={13} /> Save key</Btn></div>}</Card>;
}
