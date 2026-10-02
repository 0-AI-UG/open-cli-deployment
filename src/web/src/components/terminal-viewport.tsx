import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import { Terminal, type ITerminalOptions } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";

export type TerminalViewportHandle = {
  write: (data: string | Uint8Array) => void;
  writeln: (data: string) => void;
  reset: () => void;
  clear: () => void;
  focus: () => void;
  getSize: () => { cols: number; rows: number };
};

type Props = {
  className?: string;
  style?: CSSProperties;
  options?: ITerminalOptions;
  focusOnWindow?: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onReady?: () => void;
};

const DEFAULT_OPTIONS: ITerminalOptions = {
  fontFamily: "IBM Plex Mono, monospace",
  fontSize: 12,
  lineHeight: 1.2,
  // A fixed dark well in both light and dark panel themes (see the logs style).
  theme: {
    background: "#0B0B0C",
    foreground: "#E4E4E7",
    cursor: "#E4E4E7",
    cursorAccent: "#0B0B0C",
    selectionBackground: "#3F3F46",
  },
  cursorBlink: true,
  scrollback: 5000,
};

export const TerminalViewport = forwardRef<TerminalViewportHandle, Props>(function TerminalViewport({
  className,
  style,
  options,
  focusOnWindow = true,
  onData,
  onResize,
  onReady,
}, forwardedRef) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const initialOptionsRef = useRef(options);
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  onDataRef.current = onData;
  onResizeRef.current = onResize;
  onReadyRef.current = onReady;

  useImperativeHandle(forwardedRef, () => ({
    write: (data) => terminalRef.current?.write(data),
    writeln: (data) => terminalRef.current?.writeln(data),
    reset: () => terminalRef.current?.reset(),
    clear: () => terminalRef.current?.clear(),
    focus: () => terminalRef.current?.focus(),
    getSize: () => ({
      cols: terminalRef.current?.cols ?? 80,
      rows: terminalRef.current?.rows ?? 24,
    }),
  }), []);

  useEffect(() => {
    const terminal = new Terminal({ ...DEFAULT_OPTIONS, ...initialOptionsRef.current });
    const fit = new FitAddon();
    const container = containerRef.current;
    terminal.loadAddon(fit);
    if (container) terminal.open(container);
    terminalRef.current = terminal;

    const fitAndNotify = () => {
      try {
        fit.fit();
        onResizeRef.current?.(terminal.cols, terminal.rows);
      } catch { /* terminal may be disposed */ }
    };
    const readyFrame = requestAnimationFrame(() => {
      fitAndNotify();
      onReadyRef.current?.();
    });
    // The web font may arrive after xterm's initial character measurement.
    void document.fonts.load('12px "IBM Plex Mono"').then(fitAndNotify).catch(() => {});

    const dataSubscription = terminal.onData((data) => onDataRef.current?.(data));
    const resizeObserver = new ResizeObserver(fitAndNotify);
    if (container) resizeObserver.observe(container);
    window.addEventListener("resize", fitAndNotify);

    const onWindowFocus = () => {
      if (focusOnWindow) terminal.focus();
    };
    if (focusOnWindow) window.addEventListener("focus", onWindowFocus);

    return () => {
      cancelAnimationFrame(readyFrame);
      window.removeEventListener("resize", fitAndNotify);
      window.removeEventListener("focus", onWindowFocus);
      resizeObserver.disconnect();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [focusOnWindow]);

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden rounded-lg border bg-[#0B0B0C] p-2 shadow-xs ${className ?? ""}`}
      style={style}
      onPointerDown={() => terminalRef.current?.focus()}
    />
  );
});
