// TCP data path: echo end-to-end, connect-retry failover, and auth fail-close.
// Everything runs on 127.0.0.1 with ephemeral ports — no panel, no containers.
import { describe, test, expect } from "bun:test";
import { openTcpListener } from "./tcp.ts";
import type { ProxyApp } from "./config.ts";

let nextAppId = 100;

function app(over: Partial<ProxyApp> = {}): ProxyApp {
  return {
    appId: nextAppId++,
    name: "web",
    vip: "127.0.0.1",
    frontPorts: [80],
    backends: [],
    ...over,
  };
}

function echoServer(): { port: number; received: Buffer[]; stop(): void } {
  const received: Buffer[] = [];
  const listener = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        received.push(Buffer.from(chunk));
        socket.write(chunk);
      },
    },
  });
  return { port: listener.port, received, stop: () => listener.stop(true) };
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

/** Connect, write payload, resolve with everything received back once at least
 *  `expectBytes` arrived (or the peer closed). */
function roundtrip(port: number, payload: string, expectBytes = payload.length): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve(received);
      }
    };
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(payload);
        },
        data(socket, chunk) {
          received += chunk.toString();
          if (received.length >= expectBytes) {
            socket.end();
            finish();
          }
        },
        close: finish,
        error(_socket, err) {
          if (!done) reject(err);
        },
        connectError(_socket, err) {
          if (!done) reject(err);
        },
      },
    }).catch((err) => {
      if (!done) reject(err);
    });
  });
}

describe("tcp proxy", () => {
  test("echoes end-to-end through the proxy", async () => {
    const echo = echoServer();
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "tcp" },
    );
    try {
      expect(await roundtrip(handle.port, "hello through the vip")).toBe("hello through the vip");
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("fails over to a live backend when the first pick is dead", async () => {
    const echo = echoServer();
    const dead = freePort();
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${dead}`, `127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "tcp" },
    );
    try {
      // Random pick order: several roundtrips so the dead-first path is taken.
      for (let i = 0; i < 4; i++) {
        expect(await roundtrip(handle.port, `attempt ${i}`)).toBe(`attempt ${i}`);
      }
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("retries past several refused backends to reach the live one", async () => {
    // Deterministic regardless of the random pick order: two dead, one live.
    const echo = echoServer();
    const dead1 = freePort();
    const dead2 = freePort();
    const handle = openTcpListener(
      app({ backends: [`127.0.0.1:${dead1}`, `127.0.0.1:${dead2}`, `127.0.0.1:${echo.port}`] }),
      { port: 0, protocol: "tcp" },
    );
    try {
      expect(await roundtrip(handle.port, "past the dead")).toBe("past the dead");
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);

  test("empty backends closes the client", async () => {
    const handle = openTcpListener(app({ backends: [] }), { port: 0, protocol: "tcp" });
    try {
      expect(await roundtrip(handle.port, "doomed", 1)).toBe("");
    } finally {
      handle.stop();
    }
  });
});