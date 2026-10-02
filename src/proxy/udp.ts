// UDP data path: one Bun.udpSocket per (app, udp listener) on the app's VIP.
// Sessions are keyed by client addr:port, each with a connected upstream socket
// to a random backend; replies flow back to the client's address. Idle sessions
// are swept after 60s. An app with no backends drops datagrams (UDP has no hold
// semantics) — buffering happens only across the brief session-connect window.

import type { udp } from "bun";
import type { ProxyApp, ProxyListener } from "./config.ts";

const SESSION_IDLE_MS = 60_000;

export type UdpListenerHandle = {
  protocol: "udp";
  port: number;
  update(app: ProxyApp): void;
  stop(): void;
  /** Test seam: number of live client sessions. */
  sessionCount(): number;
};

type Session = {
  upstream: udp.ConnectedSocket<"buffer"> | null;
  /** Datagrams received while the upstream socket is still connecting. */
  pending: Buffer[];
  lastActive: number;
};

type State = {
  app: ProxyApp;
  socket: udp.Socket<"buffer">;
  sessions: Map<string, Session>;
};

function pickBackend(backends: string[]): string {
  return backends[Math.floor(Math.random() * backends.length)];
}

async function connectSession(state: State, session: Session, key: string, addr: string, port: number): Promise<void> {
  const backends = state.app.backends;
  if (backends.length === 0) {
    state.sessions.delete(key);
    return;
  }
  const backend = pickBackend(backends);
  const idx = backend.lastIndexOf(":");
  try {
    const upstream = await Bun.udpSocket({
      connect: { hostname: backend.slice(0, idx), port: Number(backend.slice(idx + 1)) },
      socket: {
        data(_sock, buf) {
          try {
            state.socket.send(buf, port, addr);
          } catch {
            /* client gone */
          }
        },
      },
    });
    session.upstream = upstream;
    for (const d of session.pending) upstream.send(d);
    session.pending = [];
  } catch (err) {
    console.error(`[proxy] udp dial ${backend} failed for app ${state.app.appId}: ${err}`);
    state.sessions.delete(key);
  }
}

export async function openUdpListener(app: ProxyApp, listener: ProxyListener): Promise<UdpListenerHandle> {
  const state: State = {
    app,
    socket: null as never,
    sessions: new Map(),
  };
  state.socket = await Bun.udpSocket({
    hostname: app.vip,
    port: listener.port,
    socket: {
      data(_socket, data, port, addr) {
        const key = `${addr}:${port}`;
        const existing = state.sessions.get(key);
        if (existing) {
          existing.lastActive = Date.now();
          if (existing.upstream) existing.upstream.send(Buffer.from(data));
          else existing.pending.push(Buffer.from(data));
          return;
        }
        if (state.app.backends.length === 0) return;
        const session: Session = { upstream: null, pending: [Buffer.from(data)], lastActive: Date.now() };
        state.sessions.set(key, session);
        void connectSession(state, session, key, addr, port);
      },
    },
  });

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of [...state.sessions]) {
      if (now - session.lastActive < SESSION_IDLE_MS) continue;
      session.upstream?.close();
      state.sessions.delete(key);
    }
  }, SESSION_IDLE_MS);

  return {
    protocol: "udp",
    port: state.socket.port,
    update(next) {
      state.app = next;
    },
    stop() {
      clearInterval(sweepTimer);
      for (const session of state.sessions.values()) session.upstream?.close();
      state.sessions.clear();
      try {
        state.socket.close();
      } catch {
        /* already closed */
      }
    },
    sessionCount() {
      return state.sessions.size;
    },
  };
}
