import { post, resolveApp } from "../api.ts";
import { followOp } from "../ops.ts";
import { BOLD, DIM, GREEN, RESET } from "../format.ts";
import { parseCliArgs } from "../args.ts";

function usage(): void {
  console.log(`${BOLD}Usage:${RESET} ocd move <app> --to <server> [--from <server>]

Moves every replica the app runs on the source server to the target server and
records the new placement. Stateless apps start on the target before the source
replicas are removed; apps with a volume stop, move their volume, and restart.

${BOLD}Options:${RESET}
  --to <server>     Target server name or ID
  --from <server>   Source server name or ID (required when the app is placed on
                    more than one server)

${DIM}Update the placement in .ocd-deploy.json afterwards so the next deploy keeps it.${RESET}`);
}

export async function move(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args, {
    to: { type: "string" },
    from: { type: "string" },
    help: { type: "boolean", aliases: ["h"] },
  }, { maxPositionals: 1 });
  if (parsed.flags.help === true) return usage();
  const appName = parsed.positionals[0];
  const to = parsed.flags.to as string | undefined;
  const from = parsed.flags.from as string | undefined;
  if (!appName || !to) {
    usage();
    throw new Error("Usage: ocd move <app> --to <server> [--from <server>]");
  }
  const app = await resolveApp(appName);
  const result = await post<{ op_id: number }>(`/api/apps/${app.id}/move`, { to, ...(from ? { from } : {}) });
  const followed = await followOp(result.op_id);
  if (!followed.ok) throw new Error(`Move failed: ${followed.error || "unknown error"}`);
  console.log(`${GREEN}Moved ${app.name}${from ? ` from ${from}` : ""} to ${to}.${RESET}`);
}
