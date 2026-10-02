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

/** Like roundtrip, but resolves with everything received on close OR error —
 *  contract tests expect the proxy to destroy the connection, which can
 *  surface client-side as ECONNRESET rather than a clean FIN. */
function probeUntilClose(port: number, payload: string): Promise<string> {
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
          socket.end();
          finish();
        },
        close: finish,
        error: finish,
        connectError(_socket, err) {
          if (!done) {
            done = true;
            reject(err);
          }
        },
      },
    }).catch((err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

describe("contract: authProtected connections are refused at the TCP layer (P1b)", () => {
  // REGRESSION: currently failing by design
  test("destroys an accepted connection for an authProtected app without dialing the backend", async () => {
    const echo = echoServer();
    // Contract seam: ProxyApp gains `authProtected?: boolean`.
    const protectedApp = { ...app({ backends: [`127.0.0.1:${echo.port}`] }), authProtected: true } as ProxyApp;
    const handle = openTcpListener(protectedApp, { port: 0, protocol: "tcp" });
    try {
      const got = await probeUntilClose(handle.port, "must not pass");
      expect(got).toBe(""); // no echo — the proxy destroyed us before proxying
      expect(Buffer.concat(echo.received).length).toBe(0); // and never dialed the backend
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});

describe("public listener: enforceAuth=false serves auth-protected apps raw", () => {
  test("an authProtected app still echoes through a public (enforceAuth:false) listener", async () => {
    const echo = echoServer();
    const protectedApp = { ...app({ backends: [`127.0.0.1:${echo.port}`] }), authProtected: true } as ProxyApp;
    const handle = openTcpListener(protectedApp, { port: 0, protocol: "tcp" }, { enforceAuth: false });
    try {
      // Public raw exposure is deliberately auth-free — the fail-close is skipped.
      expect(await roundtrip(handle.port, "raw and open")).toBe("raw and open");
      expect(Buffer.concat(echo.received).toString()).toBe("raw and open");
    } finally {
      handle.stop();
      echo.stop();
    }
  });

  test("the internal listener (default enforceAuth) still fail-closes the same app", async () => {
    const echo = echoServer();
    const protectedApp = { ...app({ backends: [`127.0.0.1:${echo.port}`] }), authProtected: true } as ProxyApp;
    const handle = openTcpListener(protectedApp, { port: 0, protocol: "tcp" });
    try {
      expect(await probeUntilClose(handle.port, "must not pass")).toBe("");
      expect(Buffer.concat(echo.received).length).toBe(0);
    } finally {
      handle.stop();
      echo.stop();
    }
  }, 10_000);
});
