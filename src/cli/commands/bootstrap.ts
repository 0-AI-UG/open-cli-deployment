import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArgs, positiveIntegerFlag } from "../args.ts";
import { savePanelUrl } from "../config.ts";
import { BOLD, DIM, GREEN, RESET } from "../format.ts";
import { promptHidden, promptLine } from "../prompt.ts";
import { VERSION } from "../version.ts";
import { login } from "./login.ts";
import { doctor } from "./doctor.ts";

const DEFAULT_IMAGE = `ghcr.io/0-ai-ug/open-cli-deployment:${VERSION === "dev" ? "latest" : VERSION}`;

type BootstrapConfig = {
  panel_image_ref: string;
  domain?: string;
  default_domain_suffix?: string;
  server_type?: string;
  server_location?: string;
  volume_size?: number;
};

const schema = {
  domain: { type: "string" as const },
  "app-domain": { type: "string" as const },
  "server-type": { type: "string" as const },
  location: { type: "string" as const },
  "volume-size": { type: "string" as const },
  image: { type: "string" as const },
  "no-open": { type: "boolean" as const },
};

function stringFlag(flags: Record<string, boolean | string | string[]>, name: string): string {
  const value = flags[name];
  return typeof value === "string" ? value.trim() : "";
}

function usage(): void {
  console.log(`${BOLD}Usage:${RESET} ocd bootstrap [options]

Interactively create a panel on a new Hetzner Cloud server.
This command does not require an existing panel login.

${BOLD}Options:${RESET}
  --domain=HOSTNAME         Panel hostname; omit for a self-signed nip.io address
  --app-domain=SUFFIX       Default application domain suffix
  --server-type=TYPE        Hetzner server type (default: cx23)
  --location=LOCATION       Hetzner location (default: nbg1)
  --volume-size=GB          Panel volume size (default: 10)
  --image=REF               Bootstrap image tag or digest
  --no-open                 Do not open the setup page after deployment

The Hetzner API token is read from HETZNER_API_TOKEN, or prompted for.`);
}

async function capture(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function runStreaming(command: string[], env?: Record<string, string>): Promise<{ code: number; output: string }> {
  console.log(`${DIM}$ ${command.join(" ")}${RESET}`);
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
    env: env ? { ...Bun.env, ...env } : undefined,
  });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>, target: "stdout" | "stderr") => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      output += text;
      (target === "stdout" ? globalThis.process.stdout : globalThis.process.stderr).write(text);
    }
  };
  const [, , code] = await Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr"), child.exited]);
  return { code, output };
}

async function requireCommand(name: string): Promise<void> {
  if (!Bun.which(name)) throw new Error(`${name} is required but was not found in PATH`);
}

async function resolveImage(image: string): Promise<string> {
  const pulled = await runStreaming(["docker", "pull", image]);
  if (pulled.code !== 0) throw new Error(`Unable to pull bootstrap image ${image}`);
  if (image.includes("@sha256:")) return image;
  const inspected = await capture(["docker", "image", "inspect", image, "--format", "{{index .RepoDigests 0}}"]);
  const digest = inspected.stdout.trim();
  if (inspected.code !== 0 || !digest.includes("@sha256:")) {
    throw new Error(`Docker did not return an immutable digest for ${image}`);
  }
  return digest;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
}

function insecureTlsFor(url: string): boolean {
  return new URL(url).hostname.endsWith(".nip.io");
}

function panelFetcher(insecureTls: boolean): typeof fetch {
  return insecureTls
    ? ((input: string | URL | Request, init?: RequestInit) => fetch(input, {
        ...init,
        tls: { rejectUnauthorized: false },
      } as RequestInit)) as typeof fetch
    : fetch;
}

async function waitForBrowserSetup(panelUrl: string, insecureTls: boolean): Promise<void> {
  const fetchPanel = panelFetcher(insecureTls);
  const deadline = Date.now() + 30 * 60 * 1000;
  let lastMessage = 0;
  let accountCreated = false;
  console.log(`${DIM}Waiting for first-user and passkey setup…${RESET}`);
  while (Date.now() < deadline) {
    try {
      const response = await fetchPanel(`${panelUrl}/api/setup/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const status = await response.json() as { setupComplete?: boolean; authenticationReady?: boolean };
        if (status.authenticationReady) return;
        if (status.setupComplete && !accountCreated) {
          accountCreated = true;
          console.log(`${GREEN}First user created.${RESET} Waiting for passkey registration…`);
        }
      }
    } catch {
      // DNS propagation and certificate issuance can legitimately take a few minutes.
    }
    if (Date.now() - lastMessage >= 30_000) {
      console.log(`${DIM}Still waiting at ${panelUrl}; finish setup in the browser.${RESET}`);
      lastMessage = Date.now();
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`Timed out waiting for browser setup at ${panelUrl}`);
}

export async function bootstrap(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return usage();
  const { flags } = parseCliArgs(args, schema, { maxPositionals: 0 });
  await requireCommand("docker");

  const requestedImage = stringFlag(flags, "image") || DEFAULT_IMAGE;
  const imageRef = await resolveImage(requestedImage);
  const generatedDir = mkdtempSync(join(tmpdir(), "ocd-bootstrap-"));
  const configPath = join(generatedDir, "panel.json");
  try {
    const domain = stringFlag(flags, "domain") || await promptLine("Panel domain (leave blank for nip.io): ");
    const appDomain = stringFlag(flags, "app-domain") || await promptLine("Default application domain (optional): ");
    if (!process.env.HETZNER_API_TOKEN) {
      const token = await promptHidden("Hetzner API token: ");
      if (!token) throw new Error("HETZNER_API_TOKEN is required");
      process.env.HETZNER_API_TOKEN = token;
    }
    const config: BootstrapConfig = {
      panel_image_ref: imageRef,
      ...(domain ? { domain } : {}),
      ...(appDomain ? { default_domain_suffix: appDomain } : {}),
      server_type: stringFlag(flags, "server-type") || "cx23",
      server_location: stringFlag(flags, "location") || "nbg1",
      volume_size: positiveIntegerFlag(flags["volume-size"], "volume-size", { defaultValue: 10 }),
    };
    const expectedUrl = domain ? `https://${domain}` : "";

    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    console.log(`\n${BOLD}Bootstrapping OCD panel${RESET}`);
    const dockerArgs = [
      "docker", "run", "--rm", "-v", `${configPath}:/config.json:ro`,
      "-e", "OCD_AUTO_DEPLOY=/config.json", "-e", "HETZNER_API_TOKEN", imageRef,
    ];

    const result = await runStreaming(dockerArgs);
    if (result.code !== 0) throw new Error("Panel bootstrap failed; review the output above");
    const deployed = result.output.match(/Panel deployed (?:to|:) https:\/\/([^\s]+)/)?.[1];
    const panelUrl = deployed ? `https://${deployed}` : expectedUrl;
    if (!panelUrl) throw new Error("Bootstrap succeeded but did not report the panel URL");
    const insecureTls = insecureTlsFor(panelUrl);
    console.log(`\n${GREEN}Panel bootstrap completed.${RESET}`);
    savePanelUrl(panelUrl, insecureTls);
    console.log(`Finish first-user and passkey setup at ${BOLD}${panelUrl}${RESET}`);
    if (!flags["no-open"]) openBrowser(panelUrl);
    await waitForBrowserSetup(panelUrl, insecureTls);
    console.log(`${GREEN}Browser setup complete.${RESET} Starting CLI authentication…`);
    await login([panelUrl], { insecureTls });
    await doctor([]);
  } finally {
    rmSync(generatedDir, { recursive: true, force: true });
  }
}
