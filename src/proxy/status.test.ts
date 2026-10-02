// contract: P2 — proxy status endpoint.
//
// The status module (src/proxy/status.ts) does not exist yet; every test
// lazy-imports it via a computed specifier so today the failure is a contained
// test failure (module-not-found rejection), not a harness crash.
//
// Contract seams the implementation must provide in ./status.ts:
//   export const STATUS_PORT = 18791;                       // default bind port
//   export function startStatusServer(
//     inputs: { natApplied(): boolean; listenersBound(): number; listenersTotal(): number },
//     port?: number, // injectable for tests (0 = ephemeral); defaults to STATUS_PORT; binds 127.0.0.1 only
//   ): { port: number; stop(): void };
// GET /status responds with JSON:
//   { ok, natApplied, listenersBound, listenersTotal }
// where ok === natApplied && listenersBound === listenersTotal.
import { describe, test, expect } from "bun:test";

type StatusModule = {
  STATUS_PORT: number;
  startStatusServer(
    inputs: { natApplied(): boolean; listenersBound(): number; listenersTotal(): number },
    port?: number,
  ): { port: number; stop(): void };
};

// Computed specifier: keeps tsc from resolving the not-yet-existing module and
// contains the runtime load failure inside each test.
const loadStatus = (): Promise<StatusModule> => import("./status" + ".ts") as Promise<StatusModule>;

describe("contract: status endpoint (P2)", () => {
  // REGRESSION: currently failing by design

  test("default status port constant is 18791", async () => {
    const { STATUS_PORT } = await loadStatus();
    expect(STATUS_PORT).toBe(18791);
  });

  test("GET /status returns readiness JSON; ok requires natApplied and all listeners bound", async () => {
    const { startStatusServer } = await loadStatus();
    let nat = true;
    let bound = 2;
    const server = startStatusServer(
      { natApplied: () => nat, listenersBound: () => bound, listenersTotal: () => 2 },
      0, // injectable port so tests never collide with a real proxy
    );
    const get = async (): Promise<Record<string, unknown>> => {
      const res = await fetch(`http://127.0.0.1:${server.port}/status`, { signal: AbortSignal.timeout(3000) });
      return (await res.json()) as Record<string, unknown>;
    };
    try {
      let body = await get();
      expect(body.ok).toBe(true);
      expect(body.natApplied).toBe(true);
      expect(body.listenersBound).toBe(2);
      expect(body.listenersTotal).toBe(2);
      expect(body.lastActivity).toBeUndefined();

      bound = 1; // a bind failed → not ok
      body = await get();
      expect(body.ok).toBe(false);

      bound = 2;
      nat = false; // nft apply failed → not ok
      body = await get();
      expect(body.ok).toBe(false);
    } finally {
      server.stop();
    }
  }, 10_000);
});
