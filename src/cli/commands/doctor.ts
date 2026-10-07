import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getDeployReadiness } from "../deploy-readiness.ts";
import { get, getApps, type App } from "../api.ts";
import { describePublicPort, publicPortConflicts, type PublicPort } from "../../shared/public-ports.ts";
import { manifestRepoLocation, readManifest } from "../manifest.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "../format.ts";

/** Check a manifest's public ports against the apps already on the panel:
 * every placed server must exist and no other app may hold an overlapping
 * port there. Servers are compared by name, as manifests name them. */
export function publicPortsReadiness(
  manifest: { name?: string; suggested_app_name?: string; placement: Record<string, number>; public_ports?: PublicPort[] },
  apps: App[],
  fleet: Array<{ id: number; name: string; ipv4?: string }>,
): { status: "ready" | "blocked"; detail: string; action?: { label: string; command: string } } {
  const ports = manifest.public_ports ?? [];
  const appName = manifest.suggested_app_name ?? manifest.name ?? "";
  const key = (name: string) => name.trim().toLowerCase();
  const servers = new Map(fleet.map((server) => [key(server.name), server]));
  const missing = Object.keys(manifest.placement).filter((name) =>
    !servers.has(key(name)) && !fleet.some((server) => String(server.id) === name.trim()));
  if (missing.length > 0) {
    return {
      status: "blocked",
      detail: `placement names unknown server(s): ${missing.join(", ")}`,
      action: { label: "Create the server", command: `ocd servers create --type=<type> --location=<location> --name=${missing[0]}` },
    };
  }
  const conflicts = publicPortConflicts(
    {
      name: appName,
      placement: Object.fromEntries(Object.entries(manifest.placement).map(([ref, count]) => [
        key(fleet.find((server) => String(server.id) === ref.trim())?.name ?? ref),
        count,
      ])),
      public_ports: ports,
    },
    apps.map((app) => ({
      name: app.name,
      placement: Object.fromEntries((app.placement ?? []).map((entry) => [key(entry.server_name), entry.replicas])),
      public_ports: (app.public_ports ?? []) as PublicPort[],
    })),
    (name) => servers.get(name)?.name ?? name,
  );
  if (conflicts.length > 0) {
    return {
      status: "blocked",
      detail: conflicts.join("; "),
      action: { label: "Use other ports, or place the app on another server", command: "ocd servers" },
    };
  }
  const where = Object.keys(manifest.placement).map((name) => {
    const server = servers.get(key(name));
    return server?.ipv4 ? `${name} (${server.ipv4})` : name;
  });
  return { status: "ready", detail: `${ports.map(describePublicPort).join(", ")} on ${where.join(", ")}` };
}

const icon = (status: string) => status === "ready" ? `${GREEN}✓${RESET}` : status === "blocked" ? `${RED}✗${RESET}` : `${YELLOW}!${RESET}`;

export async function doctor(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${BOLD}Usage:${RESET} ocd doctor [manifest]\n\nChecks deploy readiness without changing infrastructure or credentials.`);
    return;
  }
  const path = args.find((arg) => !arg.startsWith("-")) || ".ocd-deploy.json";
  let repository: string | undefined;
  let image: string | undefined;
  let appManifest: Parameters<typeof publicPortsReadiness>[0] | undefined;
  if (existsSync(path)) {
    const location = manifestRepoLocation(path);
    const parsed = JSON.parse(readFileSync(location.fullPath, "utf8")) as { apps?: Record<string, { manifest?: string }> };
    if (parsed.apps) {
      const first = Object.values(parsed.apps)[0]?.manifest;
      if (!first) throw new Error("Stack manifest contains no app manifests");
      const manifest = readManifest(resolve(dirname(location.fullPath), first));
      repository = manifest.build?.repository;
      image = manifest.build?.image_repository ?? manifest.image;
    } else {
      const manifest = readManifest(location.fullPath);
      appManifest = manifest;
      repository = manifest.build?.repository;
      image = manifest.build?.image_repository ?? manifest.image;
    }
    console.log(`${DIM}Manifest:${RESET} ${location.path}`);
  }
  const result = await getDeployReadiness(repository, image);
  const buildDelivery = !!repository;
  console.log(`\n${BOLD}Deploy readiness${RESET}`);
  console.log(`${icon(result.hetzner.status)} Hetzner        ${result.hetzner.configured ? "connected" : "not connected"}`);
  console.log(`${icon(result.worker.status)} Build worker   ${buildDelivery ? `${result.worker.online} online, ${result.worker.total} registered` : "not required for prebuilt images"}`);
  console.log(`${icon(result.registry.status)} Registry       ${result.registry.configured ? `${result.registry.scope} as ${result.registry.username}` : buildDelivery ? "not connected" : "anonymous pull unless the image is private"}`);
  console.log(`${icon(result.source.status)} Source access  ${buildDelivery ? (result.source.configured ? result.source.host : `${result.source.host} (public repositories only)`) : "not required for prebuilt images"}`);
  if (appManifest?.public_ports?.length) {
    const ports = publicPortsReadiness(appManifest, await getApps(), await get<Array<{ id: number; name: string; ipv4?: string }>>("/api/servers"));
    console.log(`${icon(ports.status)} Public ports   ${ports.detail}`);
    if (ports.action) result.actions.push(ports.action);
  }
  if (result.actions.length) {
    console.log(`\n${BOLD}Next actions${RESET}`);
    result.actions.forEach((action) => console.log(`  ${action.label}: ${BOLD}${action.command}${RESET}`));
  } else console.log(`\n${GREEN}Ready to deploy.${RESET}`);
}
