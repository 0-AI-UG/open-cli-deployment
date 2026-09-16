import { expect, test } from "bun:test";
import { assertReadCommand, parseOcdCommand, runOcdCommand, startAgent, type AgentRun } from "./incident-agent.ts";
import { apiRoutes } from "../routes.ts";
import { seedTestAdmin } from "../../shared/test-helpers.ts";
import db, { getUserById } from "../../shared/db.ts";
import { createServer } from "node:net";

test("agent command parser passes argv to OCD without a shell", () => {
  expect(parseOcdCommand('ocd app show "my app" --storage')).toEqual(["app", "show", "my app", "--storage"]);
  expect(parseOcdCommand("ocd logs app;touch /tmp/marker")).toEqual(["logs", "app;touch", "/tmp/marker"]);
  expect(() => parseOcdCommand("sh -c 'ocd apps'")).toThrow();
});

test("investigation allows inspection and rejects mutations", () => {
  expect(() => assertReadCommand(parseOcdCommand("ocd app show demo"))).not.toThrow();
  expect(() => assertReadCommand(parseOcdCommand("ocd logs demo --tail=100"))).not.toThrow();
  expect(() => assertReadCommand(parseOcdCommand("ocd restart demo"))).toThrow();
  expect(() => assertReadCommand(parseOcdCommand("ocd gc --execute"))).toThrow();
});

test("DeepSeek thinking-mode tool calls carry reasoning into the next request", async () => {
  const userId = seedTestAdmin();
  const now = Date.now();
  const run: AgentRun = { id: crypto.randomUUID(), incident_id: crypto.randomUUID(), user_id: userId, phase: "investigate", status: "running", result_json: "{}", messages_json: JSON.stringify([{ role: "user", content: "Investigate" }]), activity_json: "[]", error: "", created_at: now, updated_at: now };
  db.query("INSERT INTO incident_agent_runs (id,incident_id,user_id,phase,status,result_json,messages_json,activity_json,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(run.id, run.incident_id, run.user_id, run.phase, run.status, run.result_json, run.messages_json, run.activity_json, run.error, run.created_at, run.updated_at);
  const originalFetch = globalThis.fetch;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  const requests: any[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ choices: [{ message: requests.length === 1
      ? { role: "assistant", content: null, reasoning_content: "I should inspect the app.", tool_calls: [{ id: "call-read", type: "function", function: { name: "run_ocd", arguments: JSON.stringify({ command: "ocd restart app" }) } }] }
      : { role: "assistant", content: null, reasoning_content: "The read tool was rejected.", tool_calls: [{ id: "call-finish", type: "function", function: { name: "finish", arguments: JSON.stringify({ headline: "Needs review", summary: "No command ran", findings: [], options: [] }) } }] } }] });
  }) as typeof fetch;
  try {
    startAgent(run, { userId, username: "admin", tokenVersion: getUserById(userId)!.token_version });
    for (let i = 0; i < 100 && run.status === "running"; i++) await Bun.sleep(10);
    expect(run.status).toBe("complete");
    expect(requests).toHaveLength(2);
    expect(requests[0].tool_choice).toBeUndefined();
    expect(requests[1].messages.some((message: { reasoning_content?: string }) => message.reasoning_content === "I should inspect the app.")).toBe(true);
    expect(requests[1].messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("read-only"))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test("agent executes the real OCD CLI against normal panel API routes", async () => {
  const userId = seedTestAdmin();
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      socket.close(() => resolve(address.port));
    });
  });
  const server = Bun.serve({ port, routes: apiRoutes });
  const previousPort = process.env.PORT;
  process.env.PORT = String(server.port);
  try {
    const result = await runOcdCommand("ocd apps", "investigate", { userId, username: "admin", tokenVersion: getUserById(userId)!.token_version });
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("Not logged in");
  } finally {
    server.stop();
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});
