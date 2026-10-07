import { describe, expect, test } from "bun:test";
import {
  PublicPortsSchema,
  desiredPublicPortFirewalls,
  normalizePublicPorts,
  parsePublicPorts,
  publicPortConflicts,
  publicPortFirewallRules,
  publicPortsAppErrors,
  publicPortsErrors,
  toPublicPortRange,
} from "./public-ports.ts";

const TURN = [
  { port: 3478, protocol: "udp" as const },
  { port: 3478, protocol: "tcp" as const },
  { port: "49160-49999", protocol: "udp" as const },
];

describe("public port shape", () => {
  test("accepts single ports and ranges", () => {
    expect(PublicPortsSchema.safeParse(TURN).success).toBe(true);
    expect(toPublicPortRange({ port: "49160-49999", protocol: "udp" })).toEqual({ start: 49160, end: 49999, protocol: "udp" });
    expect(toPublicPortRange({ port: 3478, protocol: "tcp" })).toEqual({ start: 3478, end: 3478, protocol: "tcp" });
  });

  test("rejects malformed ports and ranges", () => {
    for (const port of [0, 65536, 3.5, "3478", "100-100", "200-100", "1-70000", "a-b"]) {
      expect(toPublicPortRange({ port, protocol: "udp" })).toBeNull();
      expect(publicPortsErrors([{ port, protocol: "udp" }])[0]?.path).toEqual([0, "port"]);
    }
  });

  test("rejects reserved fleet ports and the replica port block", () => {
    expect(publicPortsErrors([{ port: 22, protocol: "tcp" }])[0].message).toContain("22/tcp");
    expect(publicPortsErrors([{ port: "440-450", protocol: "tcp" }])[0].message).toContain("443/tcp");
    expect(publicPortsErrors([{ port: 18790, protocol: "tcp" }])).toHaveLength(1); // VIP proxy listener
    expect(publicPortsErrors([{ port: 10500, protocol: "tcp" }])[0].message).toContain("10000-20199/tcp");
    // The same numbers over UDP are free: nothing in OCD listens there.
    expect(publicPortsErrors([{ port: 443, protocol: "udp" }, { port: 10500, protocol: "udp" }])).toEqual([]);
  });

  test("rejects overlaps within one list but not across protocols", () => {
    expect(publicPortsErrors([{ port: "50000-50010", protocol: "udp" }, { port: 50005, protocol: "udp" }])[0]).toEqual({
      path: [1],
      message: "50005/udp overlaps 50000-50010/udp in the same list",
    });
    expect(publicPortsErrors(TURN)).toEqual([]);
  });

  test("bounds the number of entries", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ port: 40000 + i, protocol: "udp" as const }));
    expect(publicPortsErrors(many)[0].message).toContain("at most 10");
  });

  test("app rules: one replica per server and a non-HTTP health check", () => {
    expect(publicPortsAppErrors({ public_ports: TURN, placement: { "turn-1": 1 }, health_check_mode: "container" })).toEqual([]);
    expect(publicPortsAppErrors({ public_ports: TURN, placement: { "turn-1": 2 }, health_check_mode: "container" })[0].field).toBe("placement");
    expect(publicPortsAppErrors({ public_ports: TURN, placement: { "turn-1": 1 } })[0].field).toBe("health_check");
    expect(publicPortsAppErrors({ public_ports: [], placement: { a: 3 } })).toEqual([]);
  });

  test("parse and normalize round-trip in canonical order", () => {
    const normalized = normalizePublicPorts(TURN);
    expect(normalized.map((entry) => `${entry.port}/${entry.protocol}`)).toEqual(["3478/tcp", "3478/udp", "49160-49999/udp"]);
    expect(parsePublicPorts(JSON.stringify(normalized))).toEqual(normalized);
    expect(parsePublicPorts("not json")).toEqual([]);
    expect(parsePublicPorts(null)).toEqual([]);
  });
});

describe("public port conflicts", () => {
  const turn = { name: "turn", placement: { "7": 1 }, public_ports: TURN };

  test("an overlapping port on a shared server conflicts", () => {
    const other = { name: "game", placement: { "7": 1, "8": 1 }, public_ports: [{ port: "49990-50010", protocol: "udp" as const }] };
    expect(publicPortConflicts(turn, [other], (id) => `server-${id}`)).toEqual([
      "49160-49999/udp on server-7 overlaps 49990-50010/udp held by app game",
    ]);
  });

  test("other servers, other protocols and the app itself do not conflict", () => {
    expect(publicPortConflicts(turn, [
      { name: "elsewhere", placement: { "8": 1 }, public_ports: TURN },
      { name: "tcp-only", placement: { "7": 1 }, public_ports: [{ port: "49160-49999", protocol: "tcp" }] },
      { ...turn },
    ])).toEqual([]);
  });
});

describe("public port firewall rules", () => {
  test("renders one sorted inbound rule per declared entry", () => {
    expect(publicPortFirewallRules([{ name: "turn", public_ports: TURN }])).toEqual([
      { direction: "in", protocol: "tcp", port: "3478", source_ips: ["0.0.0.0/0", "::/0"], description: "turn 3478/tcp" },
      { direction: "in", protocol: "udp", port: "3478", source_ips: ["0.0.0.0/0", "::/0"], description: "turn 3478/udp" },
      { direction: "in", protocol: "udp", port: "49160-49999", source_ips: ["0.0.0.0/0", "::/0"], description: "turn 49160-49999/udp" },
    ]);
  });

  test("groups rules by placed server and skips servers without public ports", () => {
    const desired = desiredPublicPortFirewalls([
      { name: "turn", placement: { "7": 1, "9": 1 }, public_ports: TURN },
      { name: "web", placement: { "7": 2, "8": 1 }, public_ports: [] },
    ]);
    expect([...desired.keys()].sort()).toEqual([7, 9]);
    expect(desired.get(7)).toHaveLength(3);
  });
});
