import { useTempDataDir } from "../shared/test-helpers.ts";
useTempDataDir();
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { githubAppJwt, normalizeCiRepository, ciRepositoryFromUrl, githubCiRequest, assertCiOrganizationGroup } from "./ci-github.ts";

describe("GitHub CI trust boundaries", () => {
  test("accepts canonical repository names and rejects other hosts and shell input", () => {
    expect(normalizeCiRepository("https://github.com/Acme/Api.git")).toBe("acme/api");
    expect(ciRepositoryFromUrl("https://github.com/acme/api.git")).toBe("acme/api");
    for (const value of ["a/b;echo bad", "a/b/c", "a/..", "https://evil.test/a/b", "a/b\nrun"]) expect(() => normalizeCiRepository(value)).toThrow();
    for (const value of ["https://github.com.evil.test/a/b", "https://token@github.com/a/b", "http://github.com/a/b"]) expect(() => ciRepositoryFromUrl(value)).toThrow();
  });
  test("signs a short-lived App JWT using GitHub's RSA PEM key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = githubAppJwt({ app_id: "123", installation_id: "456", private_key: privateKey.export({ type: "pkcs1", format: "pem" }).toString() });
    const [header, payload, signature] = jwt.split(".");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(600);
  });
  test("API errors never expose a secret response body", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"token":"must-not-leak"}', { status: 403 })) as unknown as typeof fetch;
    try { await expect(githubCiRequest("/repos/a/b", "secret")).rejects.toThrow("HTTP 403"); }
    finally { globalThis.fetch = original; }
    await expect(githubCiRequest("//evil.test", "secret")).rejects.toThrow("Invalid GitHub API path");
  });
});

test("organization runner groups enforce a selected private repository boundary", async () => {
  const original = globalThis.fetch;
  let group = { id: 77, name: "OCD CI", visibility: "selected", allows_public_repositories: false };
  let repositories = [{ full_name: "acme/api", private: true }];
  globalThis.fetch = (async (url: string | URL | Request) => Response.json(String(url).includes("/repositories?") ? { repositories } : group)) as unknown as typeof fetch;
  try {
    expect(await assertCiOrganizationGroup("acme", 77, "token")).toEqual({ id: 77, name: "OCD CI", repositories: ["acme/api"] });
    group = { ...group, visibility: "all" };
    await expect(assertCiOrganizationGroup("acme", 77, "token")).rejects.toThrow("selected private");
    group = { ...group, visibility: "selected", allows_public_repositories: true };
    await expect(assertCiOrganizationGroup("acme", 77, "token")).rejects.toThrow("selected private");
    group = { ...group, allows_public_repositories: false }; repositories = [{ full_name: "acme/api", private: false }];
    await expect(assertCiOrganizationGroup("acme", 77, "token")).rejects.toThrow("public or foreign");
    repositories = [];
    await expect(assertCiOrganizationGroup("acme", 77, "token")).rejects.toThrow("at least one");
  } finally { globalThis.fetch = original; }
});
