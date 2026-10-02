// Config parsing/validation and the poll-based reloader.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, watchConfig, type ProxyConfig } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "ocd-proxy-config-"));
let fileNo = 0;

function writeConfig(content: string): string {
  const path = join(dir, `config-${fileNo++}.json`);
  writeFileSync(path, content);
  return path;
}

function validConfig(): ProxyConfig {
  return {
    version: 1,
    apps: [
      {
        appId: 5,
        name: "web",
        vip: "10.96.0.5",
        frontPorts: [80, 20005],
        backends: ["10.0.0.3:10004"],
          },
    ],
  };
}

describe("loadConfig", () => {
  test("parses a valid config", async () => {
    const cfg = await loadConfig(writeConfig(JSON.stringify(validConfig())));
    expect(cfg.version).toBe(1);
    expect(cfg.apps).toHaveLength(1);
    expect(cfg.apps[0].vip).toBe("10.96.0.5");
    expect(cfg.apps[0].frontPorts).toEqual([80, 20005]);
    expect(cfg.listenPort).toBeUndefined();
  });

  test("accepts a listenPort override, rejects out-of-range values", async () => {
    const withPort = await loadConfig(writeConfig(JSON.stringify({ ...validConfig(), listenPort: 12345 })));
    expect(withPort.listenPort).toBe(12345);
    const badPort = writeConfig(JSON.stringify({ ...validConfig(), listenPort: 0 }));
    expect(loadConfig(badPort)).rejects.toThrow(/listenPort/);
  });

  test("rejects an unknown version", async () => {
    const path = writeConfig(JSON.stringify({ ...validConfig(), version: 2 }));
    expect(loadConfig(path)).rejects.toThrow(/unknown version/);
  });

  test("rejects non-JSON content", async () => {
    expect(loadConfig(writeConfig("not json {"))).rejects.toThrow(/not valid JSON/);
  });

  test("rejects malformed app entries", async () => {
    const missingVip = validConfig();
    (missingVip.apps[0] as Record<string, unknown>).vip = 42;
    expect(loadConfig(writeConfig(JSON.stringify(missingVip)))).rejects.toThrow(/vip/);

    const badBackend = validConfig();
    badBackend.apps[0].backends = ["no-port"];
    expect(loadConfig(writeConfig(JSON.stringify(badBackend)))).rejects.toThrow(/backend/);

    const emptyPorts = validConfig();
    emptyPorts.apps[0].frontPorts = [];
    expect(loadConfig(writeConfig(JSON.stringify(emptyPorts)))).rejects.toThrow(/frontPorts/);

    const badPort = validConfig();
    badPort.apps[0].frontPorts = [80, 70000];
    expect(loadConfig(writeConfig(JSON.stringify(badPort)))).rejects.toThrow(/frontPorts/);
  });
});

describe("watchConfig", () => {
  test("invokes onChange when the file content changes, survives a broken write", async () => {
    const path = writeConfig(JSON.stringify(validConfig()));
    const seen: ProxyConfig[] = [];
    const stop = watchConfig(path, (cfg) => seen.push(cfg), 50);
    try {
      await Bun.sleep(150); // baseline seeded, unchanged content → no callback
      expect(seen).toHaveLength(0);

      writeFileSync(path, "broken {"); // parse error → logged, old config kept
      await Bun.sleep(150);
      expect(seen).toHaveLength(0);

      const next = validConfig();
      next.apps[0].backends = ["10.0.0.4:10004"];
      writeFileSync(path, JSON.stringify(next));
      await Bun.sleep(300);
      expect(seen).toHaveLength(1);
      expect(seen[0].apps[0].backends).toEqual(["10.0.0.4:10004"]);
    } finally {
      stop();
    }
  });

  test("rewriting identical content (touch) does not fire onChange", async () => {
    const content = JSON.stringify(validConfig());
    const path = writeConfig(content);
    const seen: ProxyConfig[] = [];
    const stop = watchConfig(path, (cfg) => seen.push(cfg), 50);
    try {
      await Bun.sleep(150); // baseline seeded
      writeFileSync(path, content); // mtime changes, content identical
      await Bun.sleep(200);
      expect(seen).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

describe("contract: watch baseline seeded from the initially loaded text (P6)", () => {
  // REGRESSION: currently failing by design
  test("a config write landing between initial load and the first poll fires onChange", async () => {
    const initialText = JSON.stringify(validConfig());
    const path = writeConfig(initialText);
    await loadConfig(path); // startup load — the watch baseline must be THIS text
    // The write lands after the initial load but before the watch starts —
    // exactly the window where a baseline seeded by re-reading the file
    // absorbs the change and silently never fires onChange.
    const next = validConfig();
    next.apps[0].backends = ["10.0.0.4:10004"];
    writeFileSync(path, JSON.stringify(next));
    const seen: ProxyConfig[] = [];
    // Contract seam: optional 4th arg `initialText` seeds the change-detection
    // baseline synchronously from the text loadConfig read, instead of
    // re-reading the file (which can absorb a racing write into the baseline).
    const watch = watchConfig as unknown as (
      path: string,
      onChange: (cfg: ProxyConfig) => void,
      intervalMs?: number,
      initialText?: string,
    ) => () => void;
    const stop = watch(path, (cfg) => seen.push(cfg), 50, initialText);
    try {
      await Bun.sleep(400);
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0].apps[0].backends).toEqual(["10.0.0.4:10004"]);
    } finally {
      stop();
    }
  });
});
