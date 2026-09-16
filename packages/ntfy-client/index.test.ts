import { expect, test } from "bun:test";
import { OcdNtfyClient } from "./index.ts";

test("publishes with the bound topic and bearer token", async () => {
  let request: Request | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init);
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const client = OcdNtfyClient.fromEnv({
    OCD_NTFY_URL: "https://notify.example.com",
    OCD_NTFY_TOPIC: "app-private",
    OCD_NTFY_TOKEN: "secret",
  }, "primary", fetcher);
  await client.publish("Job finished", { title: "Worker", priority: 3, tags: ["white_check_mark"] });
  expect(request?.url).toBe("https://notify.example.com/app-private");
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("authorization")).toBe("Bearer secret");
  expect(request?.headers.get("title")).toBe("Worker");
  expect(request?.headers.get("priority")).toBe("3");
  expect(request?.headers.get("tags")).toBe("white_check_mark");
  expect(await request?.text()).toBe("Job finished");
});

test("named bindings and subscription stream use their own credentials", async () => {
  let request: Request | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(input, init);
    return new Response('{"event":"open"}\n{"event":"message","message":"hello"}\n', { status: 200 });
  }) as typeof fetch;
  const client = OcdNtfyClient.fromEnv({
    OCD_JOBS_NTFY_URL: "https://notify.example.com",
    OCD_JOBS_NTFY_TOPIC: "jobs-private",
    OCD_JOBS_NTFY_TOKEN: "jobs-token",
  }, "jobs", fetcher);
  const events = [];
  for await (const event of client.subscribe()) events.push(event);
  expect(request?.url).toBe("https://notify.example.com/jobs-private/json");
  expect(request?.headers.get("authorization")).toBe("Bearer jobs-token");
  expect(events).toEqual([{ event: "open" }, { event: "message", message: "hello" }]);
});

test("rejects insecure origins and hides server error bodies", async () => {
  expect(() => new OcdNtfyClient("http://notify.example.com", "topic", "token")).toThrow(/HTTPS/);
  expect(() => new OcdNtfyClient("https://notify.example.com", "../topic", "token")).toThrow(/topic/);
  const fetcher = (async () => new Response("sensitive diagnostic", { status: 403 })) as typeof fetch;
  await expect(new OcdNtfyClient("https://notify.example.com", "topic", "token", fetcher).publish("hello"))
    .rejects.toThrow("ntfy publish failed (403)");
});
