/**
 * Public ports: an app that declares `public_ports` runs on its server's host
 * network and OCD opens exactly those ports to the internet in a per-server
 * Hetzner Cloud Firewall. This is how non-HTTP services that need real public
 * ports (a TURN relay, a game server) run on the fleet.
 *
 * Pure and dependency-light (zod only) so the CLI bundle, the panel routes and
 * the engine share one implementation of the shape, the overlap rules and the
 * firewall rules derived from it.
 */
import { z } from "zod";

export type PublicPortProtocol = "tcp" | "udp";

/** One declared port or inclusive port range, exactly as written in a
 * manifest: `port` is a number or a `"start-end"` string. */
export type PublicPort = { port: number | string; protocol: PublicPortProtocol };

/** A declared port normalized to an inclusive range. */
export type PublicPortRange = { start: number; end: number; protocol: PublicPortProtocol };

/** Ports a host-network app may never claim on a fleet server: SSH and the
 * panel ingress (Traefik). */
export const RESERVED_PUBLIC_PORTS: ReadonlyArray<PublicPortRange> = [
  { start: 22, end: 22, protocol: "tcp" },
  { start: 80, end: 80, protocol: "tcp" },
  { start: 443, end: 443, protocol: "tcp" },
];

/** TCP ports OCD itself uses on every server: published replica host ports
 * (10000 and up, bound on the private IPv4), the per-host VIP proxy
 * (18790-18791) and the internal ingress block (20000-20199). */
export const REPLICA_HOST_PORT_FLOOR = 10000;
export const REPLICA_HOST_PORT_CEILING = 20199;

/** Upper bound on entries per app; each becomes one firewall rule and Hetzner
 * allows 50 rules per firewall, shared by every app on the server. */
export const MAX_PUBLIC_PORT_ENTRIES = 10;

const RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Normalize one declared entry, or return null when it is malformed. */
export function toPublicPortRange(entry: PublicPort): PublicPortRange | null {
  if (typeof entry.port === "number") {
    return validPort(entry.port) ? { start: entry.port, end: entry.port, protocol: entry.protocol } : null;
  }
  const match = RANGE_PATTERN.exec(entry.port);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!validPort(start) || !validPort(end) || start >= end) return null;
  return { start, end, protocol: entry.protocol };
}

function overlaps(a: PublicPortRange, b: PublicPortRange): boolean {
  return a.protocol === b.protocol && a.start <= b.end && b.start <= a.end;
}

/** `3478/udp` or `49160-49999/udp`. */
export function describePublicPort(range: PublicPortRange | PublicPort): string {
  if ("start" in range) {
    return `${range.start === range.end ? range.start : `${range.start}-${range.end}`}/${range.protocol}`;
  }
  return `${range.port}/${range.protocol}`;
}

/** Every problem with a declared list. An empty result means the list is
 * valid on its own (conflicts with other apps are checked separately, against
 * the fleet). `path` is relative to the list. */
export function publicPortsErrors(ports: PublicPort[]): Array<{ path: Array<string | number>; message: string }> {
  const errors: Array<{ path: Array<string | number>; message: string }> = [];
  if (ports.length > MAX_PUBLIC_PORT_ENTRIES) {
    errors.push({ path: [], message: `expected at most ${MAX_PUBLIC_PORT_ENTRIES} entries, got ${ports.length}` });
  }
  const ranges: PublicPortRange[] = [];
  ports.forEach((entry, index) => {
    const range = toPublicPortRange(entry);
    if (!range) {
      errors.push({
        path: [index, "port"],
        message: `expected an integer 1-65535 or a "start-end" range with start < end, got ${JSON.stringify(entry.port)}`,
      });
      return;
    }
    const reserved = RESERVED_PUBLIC_PORTS.find((r) => overlaps(r, range));
    if (reserved) {
      errors.push({ path: [index], message: `${describePublicPort(range)} overlaps ${describePublicPort(reserved)}, which OCD reserves on every server` });
    }
    if (range.protocol === "tcp" && range.start <= REPLICA_HOST_PORT_CEILING && range.end >= REPLICA_HOST_PORT_FLOOR) {
      errors.push({
        path: [index],
        message: `${describePublicPort(range)} overlaps ${REPLICA_HOST_PORT_FLOOR}-${REPLICA_HOST_PORT_CEILING}/tcp, which OCD uses for replica and internal ingress ports`,
      });
    }
    const duplicate = ranges.find((other) => overlaps(other, range));
    if (duplicate) errors.push({ path: [index], message: `${describePublicPort(range)} overlaps ${describePublicPort(duplicate)} in the same list` });
    ranges.push(range);
  });
  return errors;
}

export const PublicPortsSchema = z.array(
  z.object({
    port: z.union([z.number(), z.string()], { error: 'expected an integer port or a "start-end" range' }),
    protocol: z.enum(["tcp", "udp"], { error: 'expected "tcp" | "udp"' }),
  }, { error: "expected object { port, protocol }" }).strict(),
  { error: "expected an array of { port, protocol }" },
).superRefine((ports, ctx) => {
  for (const { path, message } of publicPortsErrors(ports)) ctx.addIssue({ code: "custom", message, path });
});

/** Rules shared by the manifest schema and the API validator for an app that
 * declares public ports. Returns error messages keyed by manifest field. */
export function publicPortsAppErrors(app: {
  public_ports?: PublicPort[];
  placement?: Record<string, number>;
  health_check_mode?: string;
}): Array<{ field: string; message: string }> {
  if (!app.public_ports?.length) return [];
  const errors: Array<{ field: string; message: string }> = [];
  if (app.placement && Object.values(app.placement).some((count) => count !== 1)) {
    errors.push({ field: "placement", message: "apps with public_ports bind host ports, so each placed server runs exactly 1 replica" });
  }
  if ((app.health_check_mode ?? "http") === "http") {
    errors.push({
      field: "health_check",
      message: 'apps with public_ports need health_check.mode "container", "exec" or "heartbeat" (the HTTP probe targets a published port, and host-network apps publish none)',
    });
  }
  return errors;
}

export function parsePublicPorts(raw: string | null | undefined): PublicPort[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const result = PublicPortsSchema.safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/** Canonical order (protocol, then first port) so equal lists compare and
 * serialize equally. */
export function normalizePublicPorts(ports: PublicPort[]): PublicPort[] {
  return [...ports]
    .map((entry) => ({ port: entry.port, protocol: entry.protocol }))
    .sort((a, b) =>
      a.protocol.localeCompare(b.protocol) ||
      (toPublicPortRange(a)?.start ?? 0) - (toPublicPortRange(b)?.start ?? 0));
}

type PortClaimant = { name: string; placement: Record<string, number>; public_ports: PublicPort[] };

/**
 * The claims another app already holds on any server this app is placed on.
 * Placements are resolved (server id keys). Returns one message per conflict.
 */
export function publicPortConflicts(
  app: PortClaimant,
  others: PortClaimant[],
  serverName: (serverId: string) => string = (id) => `#${id}`,
): string[] {
  const conflicts: string[] = [];
  const mine = app.public_ports.map(toPublicPortRange).filter((r): r is PublicPortRange => r !== null);
  if (mine.length === 0) return conflicts;
  for (const other of others) {
    if (other.name === app.name) continue;
    const theirs = other.public_ports.map(toPublicPortRange).filter((r): r is PublicPortRange => r !== null);
    for (const serverId of Object.keys(app.placement)) {
      if (!other.placement[serverId]) continue;
      for (const range of mine) {
        const clash = theirs.find((candidate) => overlaps(candidate, range));
        if (clash) {
          conflicts.push(
            `${describePublicPort(range)} on ${serverName(serverId)} overlaps ${describePublicPort(clash)} held by app ${other.name}`,
          );
        }
      }
    }
  }
  return conflicts;
}

/** Hetzner Cloud Firewall inbound rule (the subset OCD writes). */
export type PublicPortFirewallRule = {
  direction: "in";
  protocol: PublicPortProtocol;
  port: string;
  source_ips: string[];
  description: string;
};

const ANY_SOURCE = ["0.0.0.0/0", "::/0"];

/** The exact inbound rules one server's public-ports firewall must hold for
 * the apps placed on it. Sorted for stable comparison. */
export function publicPortFirewallRules(
  apps: Array<{ name: string; public_ports: PublicPort[] }>,
): PublicPortFirewallRule[] {
  const rules: PublicPortFirewallRule[] = [];
  for (const app of apps) {
    for (const entry of app.public_ports) {
      const range = toPublicPortRange(entry);
      if (!range) continue;
      rules.push({
        direction: "in",
        protocol: range.protocol,
        port: range.start === range.end ? String(range.start) : `${range.start}-${range.end}`,
        source_ips: ANY_SOURCE,
        description: `${app.name} ${describePublicPort(range)}`.slice(0, 255),
      });
    }
  }
  return rules.sort((a, b) =>
    a.protocol.localeCompare(b.protocol) ||
    Number(a.port.split("-")[0]) - Number(b.port.split("-")[0]) ||
    a.description.localeCompare(b.description));
}

/** Desired rules per server id, for every server that has at least one. */
export function desiredPublicPortFirewalls(
  apps: Array<{ name: string; placement: Record<string, number>; public_ports: PublicPort[] }>,
): Map<number, PublicPortFirewallRule[]> {
  const byServer = new Map<number, Array<{ name: string; public_ports: PublicPort[] }>>();
  for (const app of apps) {
    if (app.public_ports.length === 0) continue;
    for (const serverId of Object.keys(app.placement).map(Number)) {
      const list = byServer.get(serverId) ?? [];
      list.push(app);
      byServer.set(serverId, list);
    }
  }
  return new Map([...byServer].map(([serverId, list]) => [serverId, publicPortFirewallRules(list)]));
}
