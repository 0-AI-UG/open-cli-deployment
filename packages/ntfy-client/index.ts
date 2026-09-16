/** Fetch-based client for an OCD-managed private ntfy topic. */
export class OcdNtfyClient {
  private readonly topicUrl: string;

  constructor(url: string, topic: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    const base = new URL(url);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      throw new Error("OCD ntfy requires an HTTPS server origin");
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(topic) || !token) throw new Error("OCD ntfy requires a topic and token");
    this.topicUrl = new URL(encodeURIComponent(topic), base).toString();
  }

  static fromEnv(env: Record<string, string | undefined>, binding = "primary", fetcher: typeof fetch = fetch): OcdNtfyClient {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(binding)) throw new Error("Invalid OCD ntfy binding name");
    const prefix = binding === "primary" ? "OCD_NTFY" : `OCD_${binding.toUpperCase()}_NTFY`;
    return new OcdNtfyClient(env[`${prefix}_URL`] ?? "", env[`${prefix}_TOPIC`] ?? "", env[`${prefix}_TOKEN`] ?? "", fetcher);
  }

  async publish(message: string, options: { title?: string; priority?: number; tags?: string[]; signal?: AbortSignal } = {}): Promise<void> {
    const headers = new Headers({ authorization: `Bearer ${this.token}`, "content-type": "text/plain; charset=utf-8" });
    if (options.title) headers.set("Title", options.title);
    if (options.priority !== undefined) {
      if (!Number.isInteger(options.priority) || options.priority < 1 || options.priority > 5) throw new Error("ntfy priority must be between 1 and 5");
      headers.set("Priority", String(options.priority));
    }
    if (options.tags?.length) headers.set("Tags", options.tags.join(","));
    const response = await this.fetcher(this.topicUrl, { method: "POST", headers, body: message, redirect: "manual", signal: options.signal ?? AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`ntfy publish failed (${response.status})`);
  }

  /** Streams newline-delimited ntfy JSON events until the signal is aborted. */
  async *subscribe(signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const response = await this.fetcher(`${this.topicUrl}/json`, {
      headers: { authorization: `Bearer ${this.token}` }, redirect: "manual", signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`ntfy subscribe failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) yield JSON.parse(line) as Record<string, unknown>;
        }
      }
      pending += decoder.decode();
      if (pending.trim()) yield JSON.parse(pending) as Record<string, unknown>;
    } finally {
      await reader.cancel();
    }
  }
}
