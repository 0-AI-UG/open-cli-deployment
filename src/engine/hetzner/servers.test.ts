import { useTempDataDir } from "../../shared/test-helpers.ts";
useTempDataDir();

import { describe, test, expect } from "bun:test";
import { BASE_FIREWALL_RULES, reconcileFirewallRules, type FirewallRule } from "./servers.ts";

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
