import { get, post, put, del } from "../api.ts";
import { followOp } from "../ops.ts";
import { table, colorStatus } from "../format.ts";

type Runner = { id: number; name: string; repository: string; status: string; shared_builds: number; draining: number; runner_version: string; last_error: string; server: { name: string } | null; actions_url: string };
function flag(args: string[], name: string): string | undefined {
  const equal = args.find(arg => arg.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}
async function follow(result: { op_id: number }): Promise<void> {
  const operation = await followOp(result.op_id);
  if (!operation.ok) throw new Error(operation.error || `CI operation #${result.op_id} failed`);
}
async function resolveRunner(ref?: string): Promise<Runner> {
  const runners = await get<Runner[]>("/api/ci/runners");
  const runner = runners.find(row => String(row.id) === ref || row.name === ref);
  if (!runner) throw new Error(`CI runner not found: ${ref || "missing name or ID"}`);
  return runner;
}
export async function ci(args: string[] = []): Promise<void> {
  const [command = "ls", ...rest] = args;
  if (["ls", "status"].includes(command)) {
    const runners = await get<Runner[]>("/api/ci/runners");
    table(["ID", "NAME", "SERVER", "SCOPE", "MODE", "STATUS", "VERSION"], runners.map(row => [String(row.id), row.name, row.server?.name || "missing", row.repository, row.shared_builds ? "shared" : "dedicated", colorStatus(row.draining ? `${row.status} (draining)` : row.status), row.runner_version || "-"]));
    for (const row of runners.filter(row => row.last_error)) console.log(`${row.name}: ${row.last_error}`);
    return;
  }
  if (command === "connect") {
    if (rest[0] !== "github") throw new Error("Usage: ocd ci connect github --app-id=ID --installation-id=ID --private-key-file=PATH");
    if (rest.includes("--token-stdin")) {
      const token = (await Bun.stdin.text()).trim();
      await put("/api/ci/connection", { access_token: token });
      console.log("GitHub account connected for CI; its token is encrypted on the panel.");
      return;
    }
    const keyFile = flag(rest, "private-key-file");
    const appId = flag(rest, "app-id");
    const installationId = flag(rest, "installation-id");
    if (!keyFile || !appId || !installationId) throw new Error("Supply --app-id, --installation-id, and --private-key-file");
    await put("/api/ci/connection", { app_id: appId, installation_id: installationId, private_key: await Bun.file(keyFile).text() });
    console.log("GitHub App connected for CI.");
    return;
  }
  if (command === "install") {
    const serverRef = flag(rest, "server");
    const repository = flag(rest, "repository");
    const organization = flag(rest, "organization");
    if (!serverRef || (!!repository === !!organization)) throw new Error("Usage: ocd ci install --server=NAME --repository=OWNER/REPO [--name=NAME]");
    const servers = await get<{ id: number; name: string }[]>("/api/servers");
    const server = servers.find(row => row.name === serverRef || String(row.id) === serverRef);
    if (!server) throw new Error(`Server not found: ${serverRef}`);
    await follow(await post("/api/ci/runners", { server_id: server.id, repository, organization, shared_builds: rest.includes("--share-builds"), job_timeout_seconds: Number(flag(rest, "job-timeout-minutes") || "30") * 60, runner_group_id: flag(rest, "runner-group") ? Number(flag(rest, "runner-group")) : undefined, name: flag(rest, "name") }));
    console.log(`CI runner installed on ${server.name}. Use runs-on: [self-hosted, linux, x64, ocd-ci] in GitHub Actions.`);
    return;
  }
  if (["drain", "resume", "retry", "remove"].includes(command)) {
    const runner = await resolveRunner(rest[0]);
    await follow(command === "remove" ? await del(`/api/ci/runners/${runner.id}`) : await post(`/api/ci/runners/${runner.id}`, { action: command }));
    console.log(command === "drain" ? "Runner draining; its active job can finish. Check ocd ci status." : `CI runner ${command} complete.`);
    return;
  }
  if (command === "checks") {
    const sourceId = rest[0];
    if (!sourceId || !/^\d+$/.test(sourceId)) throw new Error("Usage: ocd ci checks SOURCE_ID [--file=POLICY.json]");
    const file = flag(rest, "file");
    const result = file ? await put(`/api/build-sources/${sourceId}/ci`, await Bun.file(file).json()) : await get(`/api/build-sources/${sourceId}/ci`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Usage: ocd ci <command>
  connect github --app-id=ID --installation-id=ID --private-key-file=PATH
  connect github --token-stdin
  install --server=NAME --repository=OWNER/REPO [--name=NAME]
  install --server=NAME --organization=ORG --runner-group=ID [--name=NAME]
      [--share-builds] [--job-timeout-minutes=30]
  ls | status
  drain <name|id>       Finish the current job and stop accepting jobs
  resume <name|id>      Resume a drained runner
  retry <name|id>       Retry installation or reconciliation
  remove <name|id>      Drain and remove runner software; retain the server
  checks SOURCE_ID [--file=POLICY.json]
                       Configure exact-commit deployment check requirements`);
}
