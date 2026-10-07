import { useTempDataDir, randomSuffix } from "../shared/test-helpers.ts";
useTempDataDir();

import { describe, expect, test } from "bun:test";
import * as db from "../shared/db.ts";
import { publicPortsFirewallsFromDb } from "./public-ports.ts";

const IMAGE_REF = `ghcr.io/acme/turn@sha256:${"b".repeat(64)}`;

function server(providerId: string) {
  return db.insertServer({
    name: `srv-${randomSuffix()}`, provider_id: providerId, ipv4: "203.0.113.20", ipv6: "",
    type: "cx23", location: "nbg1", status: "ready",
  });
}

function app(placement: Record<string, number>, ports: Array<{ port: number | string; protocol: "tcp" | "udp" }>) {
  return db.insertApp({
    name: `app-${randomSuffix()}`, domain: "", image_ref: IMAGE_REF, container_port: 3478,
    env_vars: "{}", placement, public_ports: ports,
  });
}

describe("publicPortsFirewallsFromDb", () => {
  test("one firewall per Hetzner server that runs an app with public ports", () => {
    const turnServer = server("2001");
    const webServer = server("2002");
    const local = server("");
    const turn = app({ [String(turnServer.id)]: 1, [String(local.id)]: 1 }, [
      { port: "49160-49999", protocol: "udp" },
      { port: 3478, protocol: "udp" },
    ]);
    app({ [String(webServer.id)]: 2 }, []);

    const desired = publicPortsFirewallsFromDb();
    expect(desired).toEqual([{
      serverId: turnServer.id,
      providerId: "2001",
      rules: [
        { direction: "in", protocol: "udp", port: "3478", source_ips: ["0.0.0.0/0", "::/0"], description: `${turn.name} 3478/udp` },
        { direction: "in", protocol: "udp", port: "49160-49999", source_ips: ["0.0.0.0/0", "::/0"], description: `${turn.name} 49160-49999/udp` },
      ],
    }]);
    expect(publicPortsFirewallsFromDb([turn.id])).toEqual([]);
  });
});
