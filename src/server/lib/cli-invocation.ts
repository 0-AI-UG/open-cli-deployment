import { existsSync } from "node:fs";
import path from "node:path";

/** The downloadable production binary and the source CLI entrypoint are the
 * two supported ways to execute OCD from a panel process. */
export function cliInvocation(argv: string[]): string[] {
  const override = process.env.OCD_WEB_CLI_BINARY;
  if (override) return [override, ...argv];
  const binary = path.resolve(import.meta.dir, `../../../dist/cli/ocd-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(binary)) return [binary, ...argv];
  return [process.execPath, "run", path.resolve(import.meta.dir, "../../cli/main.ts"), ...argv];
}
