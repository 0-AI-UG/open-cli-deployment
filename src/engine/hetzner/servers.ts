import { hetznerApi } from "./api.ts";
import { isNotFoundError } from "../../shared/hetzner/errors.ts";

function log(context: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [hetzner:${context}]`, ...args);
}

export type FirewallRule = {
  direction: string;
  protocol: string;
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
  description?: string;
};

type HetznerFirewall = { id: number; rules?: FirewallRule[] };
type HetznerServer = {
  id: number;
  status: string;
  public_net: { ipv4: { ip: string }; ipv6: { ip: string } };
  private_net?: Array<{ network: number; ip: string }>;
  name: string;
};
type WithFirewall = { firewall: HetznerFirewall };
type WithServer = { server: HetznerServer };

// --- Firewall ---

const FIREWALL_NAME = "open-cli-deployment";

const ANY_SOURCE = ["0.0.0.0/0", "::/0"];

/** Base inbound rules every fleet server gets. */
export const BASE_FIREWALL_RULES: FirewallRule[] = [
  { direction: "in", protocol: "tcp", port: "22", source_ips: ANY_SOURCE, description: "SSH" },
  { direction: "in", protocol: "tcp", port: "80", source_ips: ANY_SOURCE, description: "HTTP" },
  { direction: "in", protocol: "tcp", port: "443", source_ips: ANY_SOURCE, description: "HTTPS" },
  { direction: "in", protocol: "icmp", source_ips: ANY_SOURCE, description: "ICMP ping" },
];

function sameRuleSlot(a: FirewallRule, b: FirewallRule): boolean {
  return a.direction === b.direction && a.protocol === b.protocol && (a.port ?? "") === (b.port ?? "");
}

/**
 * Reconcile an existing firewall's rules against BASE_FIREWALL_RULES: returns
 * the full desired rule set (base rules re-asserted, operator-added extras
 * preserved) when anything is missing, or null when already converged. Pure —
 * exported for tests; ensureFirewall applies the result via set_rules. This
 * is how a pre-existing fleet firewall picks up newly added base rules
 * without manual work.
 */
export function reconcileFirewallRules(existing: FirewallRule[]): FirewallRule[] | null {
  const missing = BASE_FIREWALL_RULES.filter((b) => !existing.some((r) => sameRuleSlot(r, b)));
  if (missing.length === 0) return null;
  const extras = existing
    .filter((r) => !BASE_FIREWALL_RULES.some((b) => sameRuleSlot(r, b)))
    .map((r) => ({
      direction: r.direction,
      protocol: r.protocol,
      port: r.port,
      source_ips: r.source_ips,
      destination_ips: r.destination_ips,
      description: r.description,
    }));
  return [...BASE_FIREWALL_RULES, ...extras];
}

export async function ensureFirewall(): Promise<number> {
  // Check if our firewall already exists
  const list = await hetznerApi(`/firewalls?name=${FIREWALL_NAME}`) as unknown as { firewalls: HetznerFirewall[] };
  const firewalls = list.firewalls;
  if (firewalls.length > 0) {
    const fw = firewalls[0];
    log("firewall", `Using existing firewall: id=${fw.id}`);

    // Converge missing base rules (new base rules after an upgrade, or rules
    // wiped by a bug), keeping any operator-added extras.
    const desired = reconcileFirewallRules(fw.rules ?? []);
    if (desired) {
      log("firewall", `Updating firewall rules (${(fw.rules ?? []).length} -> ${desired.length}): re-asserting base rules`);
      await hetznerApi(`/firewalls/${fw.id}/actions/set_rules`, {
        method: "POST",
        body: JSON.stringify({ rules: desired }),
      });
      log("firewall", "Firewall rules updated");
    }

    return fw.id;
  }

  log("firewall", "Creating Hetzner Cloud Firewall...");
  const fwCreateData = await hetznerApi("/firewalls", {
    method: "POST",
    body: JSON.stringify({
      name: FIREWALL_NAME,
      labels: { managed_by: "open-cli-deployment" },
      rules: BASE_FIREWALL_RULES,
    }),
  }) as unknown as WithFirewall;
  log("firewall", `Firewall created: id=${fwCreateData.firewall.id}`);
  return fwCreateData.firewall.id;
}

/** Ensure the fleet firewall is attached to an existing server. Provisioning
 * supplies it at create time; this repairs detachments and newly recreated
 * firewalls. Hetzner reports an already-applied relationship as a conflict,
 * which is a successful idempotent outcome here. */
export async function ensureFirewallAttached(firewallId: string | number, serverId: string | number): Promise<void> {
  try {
    await hetznerApi(`/firewalls/${firewallId}/actions/apply_to_resources`, {
      method: "POST",
      body: JSON.stringify({
        apply_to: [{ type: "server", server: { id: Number(serverId) } }],
      }),
    });
  } catch (error) {
    if (/firewall_already_applied|already (been )?applied|already assigned|conflict/i.test(error instanceof Error ? error.message : String(error))) return;
    throw error;
  }
}

// --- Public-port firewalls ---
//
// The fleet firewall above is shared by every server, so it cannot open a
// port on one server only. Apps with public ports get a second, per-server
// firewall that OCD owns completely: its rules are exactly the public ports
// of the apps placed on that server, and it is deleted when none remain.
// Hetzner combines the rules of every firewall applied to a server.

const PUBLIC_PORTS_ROLE = "public-ports";

export type PublicPortsFirewall = {
  id: number;
  name: string;
  labels?: Record<string, string>;
  rules?: FirewallRule[];
  applied_to?: Array<{ type: string; server?: { id: number } }>;
};

export type DesiredPublicPortsFirewall = {
  /** OCD server id. */
  serverId: number;
  /** Hetzner server id. */
  providerId: string;
  rules: FirewallRule[];
};

export type PublicPortsFirewallAction =
  | { kind: "create"; serverId: number; providerId: string; rules: FirewallRule[] }
  | { kind: "set_rules"; firewallId: number; rules: FirewallRule[] }
  | { kind: "apply"; firewallId: number; providerId: string }
  | { kind: "remove_from"; firewallId: number; providerIds: string[] }
  | { kind: "delete"; firewallId: number };

export function publicPortsFirewallName(serverId: number): string {
  return `ocd-public-ports-${serverId}`;
}

function ruleKey(rule: FirewallRule): string {
  return JSON.stringify([
    rule.direction,
    rule.protocol,
    rule.port ?? "",
    [...(rule.source_ips ?? [])].sort(),
    rule.description ?? "",
  ]);
}

function sameRules(a: FirewallRule[], b: FirewallRule[]): boolean {
  const left = a.map(ruleKey).sort();
  const right = b.map(ruleKey).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function appliedServerIds(firewall: PublicPortsFirewall): string[] {
  return (firewall.applied_to ?? [])
    .filter((entry) => entry.type === "server" && entry.server)
    .map((entry) => String(entry.server!.id));
}

/**
 * Plan the Hetzner calls that make the public-ports firewalls match the
 * desired rules. Pure; exported for tests. Each desired server ends with one
 * firewall holding exactly its rules and applied to it alone; every other
 * OCD public-ports firewall is detached and deleted.
 */
export function planPublicPortsFirewalls(
  existing: PublicPortsFirewall[],
  desired: DesiredPublicPortsFirewall[],
): PublicPortsFirewallAction[] {
  const actions: PublicPortsFirewallAction[] = [];
  const kept = new Set<number>();
  for (const want of desired) {
    if (want.rules.length === 0) continue;
    const firewall = existing.find((fw) =>
      fw.labels?.["ocd-server"] === String(want.serverId) && !kept.has(fw.id));
    if (!firewall) {
      actions.push({ kind: "create", serverId: want.serverId, providerId: want.providerId, rules: want.rules });
      continue;
    }
    kept.add(firewall.id);
    if (!sameRules(firewall.rules ?? [], want.rules)) {
      actions.push({ kind: "set_rules", firewallId: firewall.id, rules: want.rules });
    }
    const applied = appliedServerIds(firewall);
    if (!applied.includes(want.providerId)) {
      actions.push({ kind: "apply", firewallId: firewall.id, providerId: want.providerId });
    }
    const stray = applied.filter((id) => id !== want.providerId);
    if (stray.length > 0) actions.push({ kind: "remove_from", firewallId: firewall.id, providerIds: stray });
  }
  for (const firewall of existing) {
    if (kept.has(firewall.id)) continue;
    const applied = appliedServerIds(firewall);
    if (applied.length > 0) actions.push({ kind: "remove_from", firewallId: firewall.id, providerIds: applied });
    actions.push({ kind: "delete", firewallId: firewall.id });
  }
  return actions;
}

async function listPublicPortsFirewalls(): Promise<PublicPortsFirewall[]> {
  const list = await hetznerApi(
    `/firewalls?label_selector=${encodeURIComponent(`ocd-role=${PUBLIC_PORTS_ROLE}`)}&per_page=50`,
  ) as unknown as { firewalls: PublicPortsFirewall[] };
  return list.firewalls ?? [];
}

/**
 * Converge the per-server public-ports firewalls on `desired` (every server
 * that should have open public ports; any other server gets none). A firewall
 * still being detached may refuse deletion; it no longer opens anything, and
 * the next reconciliation deletes it.
 */
export async function reconcilePublicPortsFirewalls(desired: DesiredPublicPortsFirewall[]): Promise<PublicPortsFirewallAction[]> {
  const actions = planPublicPortsFirewalls(await listPublicPortsFirewalls(), desired);
  for (const action of actions) {
    switch (action.kind) {
      case "create":
        log("firewall", `Creating ${publicPortsFirewallName(action.serverId)} with ${action.rules.length} rule(s)`);
        await hetznerApi("/firewalls", {
          method: "POST",
          body: JSON.stringify({
            name: publicPortsFirewallName(action.serverId),
            labels: {
              managed_by: "open-cli-deployment",
              "ocd-role": PUBLIC_PORTS_ROLE,
              "ocd-server": String(action.serverId),
            },
            rules: action.rules,
            apply_to: [{ type: "server", server: { id: Number(action.providerId) } }],
          }),
        });
        break;
      case "set_rules":
        log("firewall", `Updating public-ports firewall ${action.firewallId} to ${action.rules.length} rule(s)`);
        await hetznerApi(`/firewalls/${action.firewallId}/actions/set_rules`, {
          method: "POST",
          body: JSON.stringify({ rules: action.rules }),
        });
        break;
      case "apply":
        await ensureFirewallAttached(action.firewallId, action.providerId);
        break;
      case "remove_from":
        log("firewall", `Detaching public-ports firewall ${action.firewallId} from ${action.providerIds.join(", ")}`);
        try {
          await hetznerApi(`/firewalls/${action.firewallId}/actions/remove_from_resources`, {
            method: "POST",
            body: JSON.stringify({
              remove_from: action.providerIds.map((id) => ({ type: "server", server: { id: Number(id) } })),
            }),
          });
        } catch (error) {
          if (!/not.applied|not_found|not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
        }
        break;
      case "delete":
        try {
          await hetznerApi(`/firewalls/${action.firewallId}`, { method: "DELETE" });
          log("firewall", `Deleted public-ports firewall ${action.firewallId}`);
        } catch (error) {
          if (isNotFoundError(error)) break;
          log("firewall", `Public-ports firewall ${action.firewallId} not deleted yet (retried on the next pass): ${error}`);
        }
        break;
    }
  }
  return actions;
}

// --- Server Management ---

export async function createServer(opts: {
  name: string;
  server_type: string;
  location: string;
  ssh_key_name: string;
  firewall_id: number;
  network_id?: number;
  user_data: string;
}): Promise<HetznerServer> {
  const body: Record<string, unknown> = {
    name: opts.name,
    server_type: opts.server_type,
    location: opts.location,
    image: "docker-ce",
    ssh_keys: [opts.ssh_key_name],
    firewalls: [{ firewall: opts.firewall_id }],
    labels: { managed_by: "open-cli-deployment" },
    user_data: opts.user_data,
  };
  if (opts.network_id) {
    // Attaching the network at create time avoids a second round trip and
    // ensures the server's private IPv4 is assigned before the first SSH
    // connection — the reconciler only has to pick up existing rows.
    body.networks = [opts.network_id];
  }
  const data = await hetznerApi("/servers", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as WithServer;
  return data.server;
}

export async function getHetznerServer(serverId: string): Promise<HetznerServer> {
  const data = await hetznerApi(`/servers/${serverId}`) as unknown as WithServer;
  return data.server;
}

/** Poll Hetzner API until server status is "running" (i.e. VM has booted). */
export async function waitForServerRunning(
  serverId: string | number,
  onStatus?: (msg: string) => void,
) {
  const maxAttempts = 90;
  const interval = 2_000; // 2s — Hetzner status transitions are fast
  log("wait-running", `Waiting for server ${serverId} to reach "running" status...`);
  for (let i = 0; i < maxAttempts; i++) {
    const server = await getHetznerServer(String(serverId));
    if (server.status === "running") {
      log("wait-running", `Server ${serverId} is running after ${i * 2}s`);
      onStatus?.("Server is running");
      return;
    }
    log("wait-running", `Server ${serverId} status: ${server.status} (attempt ${i + 1})`);
    onStatus?.(`Waiting for server to boot... (${server.status})`);
    await Bun.sleep(interval);
  }
  throw new Error("Server failed to boot — try creating a new server");
}

export async function deleteHetznerServer(serverId: string) {
  try {
    await hetznerApi(`/servers/${serverId}`, { method: "DELETE" });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

export async function listHetznerServers(): Promise<HetznerServer[]> {
  const data = await hetznerApi(
    "/servers?label_selector=managed_by%3Dopen-cli-deployment&per_page=50"
  ) as unknown as { servers: HetznerServer[] };
  return data.servers;
}
