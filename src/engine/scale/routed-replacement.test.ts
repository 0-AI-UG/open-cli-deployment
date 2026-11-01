import { expect, test } from "bun:test";
import { replaceRoutedReplica } from "./routed-replacement.ts";

function service() {
  const routes = new Set(["primary", "sibling"]);
  const ready = { primary: true, sibling: true };
  let next = 0;
  const request = () => {
    const destination = [...routes][next++ % routes.size] as keyof typeof ready;
    if (!ready[destination]) throw new Error("502: request reached a stopped or unready replica");
    return 200;
  };
  return { routes, ready, request };
}

test("requests keep a serving backend while the primary is stopped and checked", async () => {
  const s = service();
  let verified = false;
  const result = await replaceRoutedReplica({
    redundant: true,
    removeFromIngress: async () => { s.routes.delete("primary"); },
    drain: async () => { expect(s.request()).toBe(200); },
    replace: async () => {
      s.ready.primary = false;
      for (let i = 0; i < 4; i++) expect(s.request()).toBe(200);
      return "new revision";
    },
    verifyReady: async () => {
      expect(s.routes.has("primary")).toBe(false);
      expect(s.request()).toBe(200);
      s.ready.primary = true;
      verified = true;
    },
    admitToIngress: async () => { expect(verified).toBe(true); s.routes.add("primary"); },
  });
  expect(result).toBe("new revision");
  for (let i = 0; i < 4; i++) expect(s.request()).toBe(200);
});

test("failed ingress removal leaves the old process running", async () => {
  let stopped = false;
  await expect(replaceRoutedReplica({
    redundant: true,
    removeFromIngress: async () => { throw new Error("ingress unavailable"); },
    drain: async () => {},
    replace: async () => { stopped = true; },
    verifyReady: async () => {},
    admitToIngress: async () => {},
  })).rejects.toThrow("ingress unavailable");
  expect(stopped).toBe(false);
});

test("an unready replacement stays out of ingress while its sibling serves", async () => {
  const s = service();
  await expect(replaceRoutedReplica({
    redundant: true,
    removeFromIngress: async () => { s.routes.delete("primary"); },
    drain: async () => {},
    replace: async () => { s.ready.primary = false; },
    verifyReady: async () => { throw new Error("database not ready"); },
    admitToIngress: async () => { s.routes.add("primary"); },
  })).rejects.toThrow("database not ready");
  expect(s.routes.has("primary")).toBe(false);
  expect(s.request()).toBe(200);
});
