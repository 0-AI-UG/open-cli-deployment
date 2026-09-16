import path from "node:path";
import db from "../../shared/db.ts";
import { secretStore } from "../../shared/secret-store.ts";
import { createUiCliToken } from "./auth.ts";
import { cliInvocation } from "./cli-invocation.ts";

export type AgentField = { id: string; label: string; type: "text" | "number" | "select" | "boolean"; required?: boolean; options?: string[]; placeholder?: string };
export type AgentOption = { id: string; label: string; description: string; fields: AgentField[] };
export type AgentResult = { headline: string; summary: string; findings: Array<{ label: string; detail: string; tone: "info" | "warning" | "success" }>; options: AgentOption[] };
export type AgentActivity = { command: string; exitCode: number; output: string; at: number };
export type AgentRun = { id: string; incident_id: string; user_id: string; phase: "investigate" | "fix"; status: "running" | "complete" | "failed"; result_json: string; messages_json: string; activity_json: string; error: string; created_at: number; updated_at: number };
type Message = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_call_id?: string; tool_calls?: ToolCall[] };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

const running = new Set<string>();
const readCommands = new Set([
  "status", "apps", "doctor", "app show", "app deployments", "app replicas", "app metrics", "app availability", "app scaling-events", "app staging",
  "logs", "stack ls", "stack status", "stack logs", "stack member-logs", "envs list", "envs show", "ops", "ops logs", "servers", "servers show", "resources", "volumes", "volumes ls", "volumes cat", "buckets list", "runners ls", "runners sources", "gc", "registry status", "source status", "scale policy show",
]);

export function parseOcdCommand(command: string): string[] {
  if (typeof command !== "string" || command.length > 4096 || /[\u0000-\u001f\u007f]/.test(command)) throw new Error("Invalid OCD command");
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += char;
    } else if (char === "'" || char === '"') { quote = char; active = true; }
    else if (char === "\\" && i + 1 < command.length) { word += command[++i]; active = true; }
    else if (/\s/.test(char)) { if (active) { words.push(word); word = ""; active = false; } }
    else { word += char; active = true; }
  }
  if (quote) throw new Error("Unclosed quote in OCD command");
  if (active) words.push(word);
  if (words.shift() !== "ocd" || !words.length) throw new Error("Command must start with ocd");
  return words;
}

export function assertReadCommand(argv: string[]): void {
  if (argv.some(arg => /^(--execute|--force|--follow|--token|--auth-password|--password|--secret)/.test(arg))) throw new Error("Investigation only accepts read-only OCD commands");
  const first = argv[0];
  const second = argv[1];
  const third = argv[2];
  const signature = first === "scale" && second === "policy" ? "scale policy show"
    : ["app", "stack", "envs", "ops", "servers", "volumes", "buckets", "runners", "registry", "source"].includes(first) && second && !second.startsWith("-") ? `${first} ${second}`
    : first;
  if (!readCommands.has(signature) || (signature === "scale policy show" && third !== "show")) throw new Error("Investigation only accepts read-only OCD commands");
  if (signature === "gc" && argv.some(x => x === "--execute")) throw new Error("GC execution is not read-only");
}

export async function runOcdCommand(command: string, phase: "investigate" | "fix", actor: { userId: string; username: string; tokenVersion: number }, approvedPlan = ""): Promise<{ exitCode: number; output: string }> {
  const argv = parseOcdCommand(command);
  if (phase === "investigate") assertReadCommand(argv);
  if (["login", "skill", "ssh"].includes(argv[0])) throw new Error("This OCD command is unavailable to the incident agent");
  if (phase === "fix") {
    const action = ["envs", "runners", "buckets", "volumes", "servers", "registry", "source", "storage-readers"].includes(argv[0]) && ["remove", "purge", "delete", "logout", "revoke"].includes(argv[1]) ? argv[1]
      : argv[0] === "gc" && argv.includes("--execute") ? "gc"
      : ["delete", "rollback", "promote", "migrate", "recover"].includes(argv[0]) ? argv[0] : "";
    if (action && !new RegExp(`\\b${action === "gc" ? "gc|cleanup" : action}\\b`, "i").test(approvedPlan)) {
      throw new Error(`The selected repair option did not approve ${action}`);
    }
  }
  const token = await createUiCliToken({ userId: actor.userId, username: actor.username, v: actor.tokenVersion }, "30m");
  const proc = Bun.spawn(cliInvocation(argv), {
    cwd: path.parse(process.cwd()).root,
    env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: process.env.LANG || "C.UTF-8", OCD_PANEL_URL: `http://127.0.0.1:${process.env.PORT || "3001"}`, OCD_TOKEN: token },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 15 * 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, output: (stdout + (stderr ? `\n${stderr}` : "")).slice(0, 20_000) };
  } finally { clearTimeout(timer); }
}

const tools = [
  { type: "function", function: { name: "run_ocd", description: "Run a single OCD CLI command. Use commands beginning with `ocd`. Investigation permits read-only commands. Fix phase permits operational commands. No shell syntax or pipelines are interpreted.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "finish", description: "Finish this phase and render structured UI cards. Investigation must include actionable options; each option may ask the user for short inputs. Fix phase reports the outcome and verification.", parameters: { type: "object", properties: {
    headline: { type: "string" }, summary: { type: "string" }, findings: { type: "array", items: { type: "object", properties: { label: { type: "string" }, detail: { type: "string" }, tone: { type: "string", enum: ["info", "warning", "success"] } }, required: ["label", "detail", "tone"] } },
    options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" }, fields: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, type: { type: "string", enum: ["text", "number", "select", "boolean"] }, required: { type: "boolean" }, options: { type: "array", items: { type: "string" } }, placeholder: { type: "string" } }, required: ["id", "label", "type"] } } }, required: ["id", "label", "description", "fields"] } },
  }, required: ["headline", "summary", "findings", "options"] } } },
] as const;

function normalizeResult(raw: unknown, phase: "investigate" | "fix"): AgentResult {
  if (!raw || typeof raw !== "object") throw new Error("Agent returned an invalid result");
  const r = raw as Record<string, unknown>;
  const str = (x: unknown, max = 2000) => typeof x === "string" ? x.slice(0, max) : "";
  const findings = Array.isArray(r.findings) ? r.findings.slice(0, 12).map(x => ({ label: str(x?.label, 120), detail: str(x?.detail), tone: ["info", "warning", "success"].includes(x?.tone) ? x.tone as "info" | "warning" | "success" : "info" })) : [];
  const options: AgentOption[] = phase === "investigate" && Array.isArray(r.options) ? r.options.slice(0, 6).map(x => ({
    id: str(x?.id, 80), label: str(x?.label, 120), description: str(x?.description), fields: Array.isArray(x?.fields) ? x.fields.slice(0, 8).map((f: any) => ({ id: str(f?.id, 80), label: str(f?.label, 120), type: ["text", "number", "select", "boolean"].includes(f?.type) ? f.type : "text", required: !!f?.required, options: Array.isArray(f?.options) ? f.options.filter((v: unknown) => typeof v === "string").slice(0, 20) : undefined, placeholder: str(f?.placeholder, 120) })) : [],
  })).filter(x => x.id && x.label) : [];
  if (!str(r.headline)) throw new Error("Agent did not provide a headline");
  return { headline: str(r.headline, 160), summary: str(r.summary), findings, options };
}

function save(run: AgentRun): void {
  run.updated_at = Date.now();
  db.query("UPDATE incident_agent_runs SET status=?,result_json=?,messages_json=?,activity_json=?,error=?,updated_at=? WHERE id=?")
    .run(run.status, run.result_json, run.messages_json, run.activity_json, run.error, run.updated_at, run.id);
}

export async function agentConfigured(): Promise<boolean> { return !!(process.env.DEEPSEEK_API_KEY || await secretStore.get("deepseek_api_key")); }
export function isRunning(id: string): boolean { return running.has(id); }

export function startAgent(run: AgentRun, actor: { userId: string; username: string; tokenVersion: number }, approvedPlan = ""): void {
  running.add(run.id);
  void executeAgent(run, actor, approvedPlan).catch(error => {
    run.status = "failed";
    run.error = error instanceof Error ? error.message.slice(0, 1000) : "Agent failed";
    save(run);
  }).finally(() => running.delete(run.id));
}

async function executeAgent(run: AgentRun, actor: { userId: string; username: string; tokenVersion: number }, approvedPlan: string): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY || await secretStore.get("deepseek_api_key");
  if (!key) throw new Error("Configure a DeepSeek API key in panel settings first");
  const messages = JSON.parse(run.messages_json) as Message[];
  const activity = JSON.parse(run.activity_json) as AgentActivity[];
  while (true) {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || "deepseek-flash", messages, tools, tool_choice: "required", stream: false }),
    });
    if (!response.ok) throw new Error(`DeepSeek API returned ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const data = await response.json() as { choices?: Array<{ message?: Message }> };
    const answer = data.choices?.[0]?.message;
    if (!answer) throw new Error("DeepSeek returned no answer");
    messages.push({ role: "assistant", content: answer.content ?? null, ...(answer.tool_calls ? { tool_calls: answer.tool_calls } : {}) });
    if (!answer.tool_calls?.length) throw new Error("DeepSeek did not call a tool");
    for (const call of answer.tool_calls) {
      let output: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        if (call.function.name === "finish") {
          const result = normalizeResult(args, run.phase);
          run.result_json = JSON.stringify(result);
          run.status = "complete";
          run.messages_json = JSON.stringify(messages);
          save(run);
          return;
        }
        if (call.function.name !== "run_ocd" || typeof args.command !== "string") throw new Error("Invalid tool call");
        const result = await runOcdCommand(args.command, run.phase, actor, approvedPlan);
        activity.push({ command: args.command, exitCode: result.exitCode, output: result.output, at: Date.now() });
        run.activity_json = JSON.stringify(activity);
        output = JSON.stringify(result);
      } catch (error) { output = JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed" }); }
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
      run.messages_json = JSON.stringify(messages);
      save(run);
    }
  }
}
