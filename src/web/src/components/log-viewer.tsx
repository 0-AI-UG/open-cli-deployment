import { useEffect, useRef, useMemo } from "react";
import { SkeletonLines } from "./ui.tsx";

// ANSI color code to CSS color mapping. The viewer is a near-black well in
// both themes, so these are tuned for contrast on #0B0B0C (zinc/tailwind 400s).
const ANSI_COLORS: Record<number, string> = {
  30: "#71717A", 31: "#F87171", 32: "#4ADE80", 33: "#FBBF24",
  34: "#60A5FA", 35: "#C084FC", 36: "#22D3EE", 37: "#E4E4E7",
  90: "#A1A1AA", 91: "#FCA5A5", 92: "#86EFAC", 93: "#FDE68A",
  94: "#93C5FD", 95: "#D8B4FE", 96: "#67E8F9", 97: "#FAFAFA",
};

const DIM = "#71717A";

interface Span {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

function parseAnsi(raw: string): Span[] {
  const spans: Span[] = [];
  let color: string | undefined;
  let bold = false;
  let dim = false;
  // eslint-disable-next-line no-control-regex
  const parts = raw.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) spans.push({ text: parts[i], color, bold, dim });
    } else {
      const codes = parts[i].split(";").map(Number);
      for (const c of codes) {
        if (c === 0) { color = undefined; bold = false; dim = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (ANSI_COLORS[c]) color = ANSI_COLORS[c];
        else if (c === 39) color = undefined;
      }
    }
  }
  return spans;
}

// Detect log level keywords and assign colors
const LEVEL_PATTERNS: [RegExp, string][] = [
  [/\b(ERROR|FATAL|PANIC|CRIT)\b/i, "#F87171"],
  [/\b(WARN|WARNING)\b/i, "#FBBF24"],
  [/\b(INFO)\b/i, "#93C5FD"],
  [/\b(DEBUG|TRACE)\b/i, DIM],
];

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\d.Z+:-]*)\s*/;
// A merged multi-source log (a stack's members) prefixes every line with the
// source it came from, after the timestamp: `13:48:43.435 [bc-postgres] …`.
// The trailing run of spaces is padding the caller added to align the messages,
// so it is captured and re-emitted rather than collapsed.
const TAG_RE = /^(\d{2}:\d{2}:\d{2}[.\d]*\s)?\[([^\]\s]+)\](\s+)/;

function colorizeLine(line: string, tagColors?: Record<string, string>): { spans: Span[]; tag?: string } {
  // First check if line has ANSI codes
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(line)) {
    return { spans: parseAnsi(line) };
  }

  const spans: Span[] = [];

  // Extract and dim the timestamp
  const tsMatch = line.match(TIMESTAMP_RE);
  if (tsMatch) {
    spans.push({ text: tsMatch[1], color: DIM });
    line = line.slice(tsMatch[0].length);
    spans.push({ text: " " });
  }

  // Pull the source tag out and give it the source's own colour, so a wall of
  // interleaved lines can be read by hue instead of by parsing each prefix.
  let tag: string | undefined;
  if (tagColors) {
    const m = line.match(TAG_RE);
    if (m && tagColors[m[2]]) {
      tag = m[2];
      if (m[1]) spans.push({ text: m[1], color: DIM });
      spans.push({ text: `[${tag}]`, color: tagColors[tag], bold: true });
      spans.push({ text: m[3] });
      line = line.slice(m[0].length);
    }
  }

  // Check for log level and color the whole remaining line accordingly
  let levelColor: string | undefined;
  for (const [re, color] of LEVEL_PATTERNS) {
    if (re.test(line)) {
      levelColor = color;
      break;
    }
  }

  if (levelColor) {
    spans.push({ text: line, color: levelColor });
  } else {
    spans.push({ text: line });
  }

  return { spans, tag };
}

function renderSpans(spans: Span[]) {
  return spans.map((s, i) => {
    if (!s.color && !s.bold && !s.dim) return s.text;
    const style: React.CSSProperties = {};
    if (s.color) style.color = s.color;
    if (s.bold) style.fontWeight = 600;
    if (s.dim) style.opacity = 0.6;
    return <span key={i} style={style}>{s.text}</span>;
  });
}

interface LogViewerProps {
  logs: string;
  className?: string;
  /** Colour per `[tag]` prefix, for logs merged from several sources. */
  tagColors?: Record<string, string>;
}

export function LogViewer({ logs, className, tagColors }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(true);

  // Track if user was scrolled to bottom before update
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (wasAtBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    wasAtBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  };

  const rendered = useMemo(() => {
    if (!logs) return null;
    const lines = logs.split("\n");
    return lines.map((line, i) => {
      const { spans, tag } = colorizeLine(line, tagColors);
      return (
        // The gutter bar carries the colour down continuation lines, which have
        // no prefix of their own — a wrapped stack trace stays visibly one source.
        <div
          key={i}
          className="log-line"
          style={tag ? { borderLeftColor: tagColors![tag] } : undefined}
        >
          {renderSpans(spans)}
        </div>
      );
    });
  }, [logs, tagColors]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className={`max-h-[500px] overflow-auto rounded-lg border bg-[#0B0B0C] p-3 font-mono text-xs leading-relaxed text-zinc-200 [color-scheme:dark] ${className || ""}`}
      style={{ tabSize: 4 }}
    >
      {rendered || <SkeletonLines inverse label="Loading logs" />}
      <style>{`
        .log-line:hover { background: rgba(255,255,255,0.04); }
        .log-line { padding: 0 6px; border-radius: 3px; white-space: pre-wrap; word-break: break-all; border-left: 2px solid transparent; }
        .log-line::selection, .log-line *::selection { background: rgba(129,140,248,0.35); }
      `}</style>
    </div>
  );
}
