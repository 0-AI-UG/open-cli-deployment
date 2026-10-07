import { describe, expect, test } from "bun:test";
import { publicPortsReadiness } from "./doctor.ts";
import type { App } from "../api.ts";

const fleet = [
  { id: 5, name: "server-2", ipv4: "198.51.100.2" },
  { id: 9, name: "turn-1", ipv4: "198.51.100.9" },
];
const manifest = {
  suggested_app_name: "cate-turn",
  placement: { "turn-1": 1 },
  public_ports: [{ port: 3478, protocol: "udp" as const }, { port: "49160-49999", protocol: "udp" as const }],
};
const app = (name: string, server: string, ports: App["public_ports"]): App => ({
  id: 1, name, status: "running", domain: "", servers: [], created_at: "",
  placement: [{ server_id: 0, server_name: server, replicas: 1 }],
  public_ports: ports,
});

describe("publicPortsReadiness", () => {
  test("reports the ports and the server addresses they open on", () => {
    expect(publicPortsReadiness(manifest, [app("web", "turn-1", [])], fleet)).toEqual({
      status: "ready",
      detail: "3478/udp, 49160-49999/udp on turn-1 (198.51.100.9)",
    });
  });

  test("blocks on an unknown server or a port another app holds there", () => {
    expect(publicPortsReadiness({ ...manifest, placement: { "turn-9": 1 } }, [], fleet).action?.command)
      .toBe("ocd servers create --type=<type> --location=<location> --name=turn-9");
    expect(publicPortsReadiness({ ...manifest, placement: { "9": 1 } }, [app("game", "Turn-1", [{ port: 3478, protocol: "udp" }])], fleet))
      .toMatchObject({ status: "blocked", detail: "3478/udp on turn-1 overlaps 3478/udp held by app game" });
    // Redeploying the same app is not a conflict with itself.
    expect(publicPortsReadiness(manifest, [app("cate-turn", "turn-1", manifest.public_ports)], fleet).status).toBe("ready");
  });
});
