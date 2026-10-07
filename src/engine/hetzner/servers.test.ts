import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import {
  BASE_FIREWALL_RULES,
  planPublicPortsFirewalls,
  reconcileFirewallRules,
  type FirewallRule,
} from "./servers.ts";

const ANY = ["0.0.0.0/0", "::/0"];

/** The pre-public-pool rule set every live fleet firewall carries. */
const PARTIAL_RULES: FirewallRule[] = [
  { direction: "in", protocol: "tcp", port: "22", source_ips: ANY, description: "SSH" },
  { direction: "in", protocol: "tcp", port: "80", source_ips: ANY, description: "HTTP" },
];

describe("reconcileFirewallRules", () => {
  test("base rules open only SSH, HTTP, HTTPS and ICMP", () => {
    expect(BASE_FIREWALL_RULES.map((rule) => `${rule.protocol}:${rule.port ?? ""}`))
      .toEqual(["tcp:22", "tcp:80", "tcp:443", "icmp:"]);
  });

  test("a firewall missing base rules converges to the base rule set", () => {
    const desired = reconcileFirewallRules(PARTIAL_RULES);
    expect(desired).not.toBeNull();
    expect(desired).toEqual(BASE_FIREWALL_RULES);
  });

  test("already-converged rules return null (no set_rules API call)", () => {
    expect(reconcileFirewallRules(BASE_FIREWALL_RULES)).toBeNull();
    // Order and extra fields don't matter — only direction/protocol/port.
    expect(reconcileFirewallRules([...BASE_FIREWALL_RULES].reverse())).toBeNull();
  });

  test("operator-added extra rules survive convergence", () => {
    const extra: FirewallRule = {
      direction: "in",
      protocol: "tcp",
      port: "5432",
      source_ips: ["203.0.113.0/24"],
      description: "operator: postgres",
    };
    const desired = reconcileFirewallRules([...PARTIAL_RULES, extra]);
    expect(desired).toEqual([...BASE_FIREWALL_RULES, extra]);
  });

  test("a wiped rule set is fully re-asserted", () => {
    expect(reconcileFirewallRules([])).toEqual(BASE_FIREWALL_RULES);
  });
});

describe("planPublicPortsFirewalls", () => {
  const rules: FirewallRule[] = [
    { direction: "in", protocol: "udp", port: "3478", source_ips: ANY, description: "turn 3478/udp" },
    { direction: "in", protocol: "udp", port: "49160-49999", source_ips: ANY, description: "turn 49160-49999/udp" },
  ];
  const owned = (id: number, serverId: number, applied: number[], current: FirewallRule[] = rules) => ({
    id,
    name: `ocd-public-ports-${serverId}`,
    labels: { "ocd-role": "public-ports", "ocd-server": String(serverId) },
    rules: current,
    applied_to: applied.map((server) => ({ type: "server", server: { id: server } })),
  });

  test("creates a missing server firewall applied to that server", () => {
    expect(planPublicPortsFirewalls([], [{ serverId: 7, providerId: "1007", rules }])).toEqual([
      { kind: "create", serverId: 7, providerId: "1007", rules },
    ]);
  });

  test("a converged firewall needs no calls, whatever the rule order", () => {
    expect(planPublicPortsFirewalls(
      [owned(50, 7, [1007], [...rules].reverse())],
      [{ serverId: 7, providerId: "1007", rules }],
    )).toEqual([]);
  });

  test("drifted rules and attachments are repaired", () => {
    expect(planPublicPortsFirewalls(
      [owned(50, 7, [1999], [rules[0]])],
      [{ serverId: 7, providerId: "1007", rules }],
    )).toEqual([
      { kind: "set_rules", firewallId: 50, rules },
      { kind: "apply", firewallId: 50, providerId: "1007" },
      { kind: "remove_from", firewallId: 50, providerIds: ["1999"] },
    ]);
  });

  test("firewalls of servers without public ports are detached and deleted", () => {
    expect(planPublicPortsFirewalls(
      [owned(50, 7, [1007]), owned(51, 8, [])],
      [{ serverId: 7, providerId: "1007", rules: [] }],
    )).toEqual([
      { kind: "remove_from", firewallId: 50, providerIds: ["1007"] },
      { kind: "delete", firewallId: 50 },
      { kind: "delete", firewallId: 51 },
    ]);
  });
});
