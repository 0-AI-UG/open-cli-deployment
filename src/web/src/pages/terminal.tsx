import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "../stores/auth.ts";
import { Btn, Spinner, PageShell, PageHeader, StatusBadge, InlineNotice } from "../components/ui.tsx";
import { TerminalViewport, type TerminalViewportHandle } from "../components/terminal-viewport.tsx";

type Props = {
  kind: "server" | "replica";
  id: number;
};

type Status = "connecting" | "open" | "disconnected" | "ended" | "error";
const terminalInputEncoder = new TextEncoder();

export function TerminalPage({ kind, id }: Props) {
  const { token } = useAuth();
  // Keep the token in a ref so reconnect() always reads the freshest value
  // without re-running the main effect (which would tear down the terminal).
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const terminalRef = useRef<TerminalViewportHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(500);
  const disposedRef = useRef(false);
  const connectingRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");

  const connect = useCallback(() => {
    if (disposedRef.current || connectingRef.current) return;
    connectingRef.current = true;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // Close previous WebSocket cleanly before opening a new one.
    const prev = wsRef.current;
    if (prev) {
      prev.onopen = prev.onmessage = prev.onerror = prev.onclose = null;
      try { prev.close(); } catch { /* cleanup */ }
      wsRef.current = null;
    }

    setStatus("connecting");
    setError("");
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/api/terminal/ws?target=${kind}:${id}&token=${encodeURIComponent(tokenRef.current || "")}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      connectingRef.current = false;
      if (disposedRef.current) { try { ws.close(); } catch { /* closed */ } return; }
      setStatus("open");
      backoffRef.current = 500;

      // Client-side heartbeat every 25s — keeps the connection alive through
      // reverse proxies by sending traffic in both directions.
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      const hb = new Uint8Array([0]);
      heartbeatRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(hb); } catch { /* ws closing */ }
        }
      }, 25_000);

      const terminal = terminalRef.current;
      if (terminal) {
        // Visual separator on reconnect so the user knows a new session started.
        if (hasConnectedRef.current) {
          terminal.write("\r\n\x1b[33m--- reconnected ---\x1b[0m\r\n");
        }
        hasConnectedRef.current = true;
        terminal.focus();
        try {
          const { cols, rows } = terminal.getSize();
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        } catch { /* ws may not be fully open yet */ }
      }
    };

    ws.onmessage = (ev) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (ev.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(ev.data);
        // Server sends a single NUL byte as an application-level heartbeat
        // to keep the connection alive through reverse proxies. Ignore it.
        if (bytes.length === 1 && bytes[0] === 0) return;
        terminal.write(bytes);
      } else {
        terminal.write(ev.data);
      }
    };

    ws.onerror = () => {
      connectingRef.current = false;
      setStatus("error");
      setError("Connection error");
    };

    ws.onclose = (ev) => {
      connectingRef.current = false;
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      if (disposedRef.current) return;

      // 4000 = clean SSH exit — don't auto-reconnect, the session ended normally.
      if (ev.code === 4000) {
        setStatus("ended");
        return;
      }

      setStatus("disconnected");
      // Exponential backoff capped at 30s.
      const delay = Math.min(backoffRef.current, 30_000);
      backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
      reconnectTimerRef.current = setTimeout(() => {
        if (!disposedRef.current) connect();
      }, delay);
    };
  }, [kind, id]);

  useEffect(() => {
    disposedRef.current = false;
    connectingRef.current = false;
    hasConnectedRef.current = false;
    backoffRef.current = 500;

    return () => {
      disposedRef.current = true;
      connectingRef.current = false;
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try { wsRef.current?.close(); } catch { /* cleanup */ }
      wsRef.current = null;
    };
  }, [kind, id, connect]);

  const handleData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(terminalInputEncoder.encode(data));
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, []);

  return (
    <PageShell width="xl">
      <PageHeader
        eyebrow={kind === "server" ? "Server" : "Replica"}
        title={`Terminal: ${kind} #${id}`}
        actions={<StatusBadge status={status} />}
      />
      {error && <InlineNotice tone="danger">{error}</InlineNotice>}
      <div className="relative">
        <TerminalViewport
          key={`${kind}:${id}`}
          ref={terminalRef}
          onReady={connect}
          onData={handleData}
          onResize={handleResize}
          className="h-[calc(100dvh-220px)] min-h-[320px] md:h-[70vh]"
        />
        {(status === "disconnected" || status === "connecting" || status === "ended") && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 text-center text-sm font-medium text-zinc-200">
              {status === "connecting" ? <span className="inline-flex items-center gap-2"><Spinner />Connecting</span>
                : status === "ended" ? <>Session ended<button type="button" className="inline-flex h-8 items-center rounded-md border border-white/15 bg-white/10 px-3 text-sm font-medium text-white transition-colors hover:bg-white/20 max-md:h-11" onClick={connect}>Reconnect</button></>
                : <><span className="inline-flex items-center gap-2"><Spinner />Disconnected, reconnecting</span><button type="button" className="inline-flex h-8 items-center rounded-md border border-white/15 bg-white/10 px-3 text-sm font-medium text-white transition-colors hover:bg-white/20 max-md:h-11" onClick={() => { backoffRef.current = 500; connect(); }}>Reconnect now</button></>
              }
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}
