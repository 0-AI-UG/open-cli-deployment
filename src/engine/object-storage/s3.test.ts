import { expect, test } from "bun:test";
import { getObjectPreview, listObjects, parseListObjects, signS3Request } from "./s3.ts";

const credentials = {
  accessKey: "AKIDEXAMPLE",
  secretKey: "test-secret",
  region: "nbg1",
  endpoint: "https://s3.example.com",
};

test("signS3Request canonicalizes and signs list query parameters", () => {
  const signed = signS3Request({
    method: "GET",
    path: "/test-bucket",
    credentials,
    now: new Date("2026-09-05T10:00:00Z"),
    query: { prefix: "photos/2026 summer/", delimiter: "/", "list-type": 2 },
  });
  expect(signed.url).toBe("https://s3.example.com/test-bucket?delimiter=%2F&list-type=2&prefix=photos%2F2026%20summer%2F");
  expect(signed.headers.authorization).toContain("Signature=f71e09685e759e965799afd9df576642499475fc4945693b9cf4ccfe64ef4ba3");
});

test("parseListObjects returns folders, objects, decoded XML, and pagination", () => {
  const result = parseListObjects(`<?xml version="1.0"?>
    <ListBucketResult>
      <IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;page</NextContinuationToken>
      <CommonPrefixes><Prefix>docs/guides/</Prefix></CommonPrefixes>
      <Contents><Key>docs/</Key><LastModified>2026-09-01T00:00:00Z</LastModified><ETag>"folder"</ETag><Size>0</Size></Contents>
      <Contents><Key>docs/a&amp;b.txt</Key><LastModified>2026-09-02T00:00:00Z</LastModified><ETag>"abc"</ETag><Size>12</Size></Contents>
    </ListBucketResult>`, "docs/");
  expect(result).toEqual({
    prefixes: ["docs/guides/"],
    objects: [{ key: "docs/a&b.txt", size: 12, lastModified: "2026-09-02T00:00:00Z", etag: "abc" }],
    nextCursor: "next&page",
  });
});

test("listObjects requests one delimiter-separated page", async () => {
  let requested: Request | null = null;
  const fetcher = (async (input, init) => {
    requested = new Request(input, init);
    return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>");
  }) as typeof fetch;
  expect(await listObjects("test-bucket", "docs/", credentials, undefined, fetcher)).toEqual({ prefixes: [], objects: [], nextCursor: null });
  const url = new URL(requested!.url);
  expect(url.searchParams.get("list-type")).toBe("2");
  expect(url.searchParams.get("delimiter")).toBe("/");
  expect(url.searchParams.get("prefix")).toBe("docs/");
  expect(requested!.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256");
});

test("getObjectPreview bounds downloads and reports text metadata", async () => {
  const body = "hello from object storage";
  let range = "";
  const fetcher = (async (_input, init) => {
    if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "999999", "content-type": "text/plain" } });
    range = new Headers(init?.headers).get("range") || "";
    return new Response(body, { status: 206 });
  }) as typeof fetch;
  const preview = await getObjectPreview("test-bucket", "docs/readme.txt", credentials, fetcher);
  expect(range).toBe("bytes=0-262143");
  expect(preview).toEqual({ size: 999999, truncated: true, binary: false, content: body, contentType: "text/plain", maxBytes: 262144 });
});

test("getObjectPreview handles empty objects without an invalid range request", async () => {
  let requests = 0;
  const fetcher = (async (_input, init) => {
    requests++;
    expect(init?.method).toBe("HEAD");
    return new Response(null, { headers: { "content-length": "0", "content-type": "text/plain" } });
  }) as typeof fetch;
  expect(await getObjectPreview("test-bucket", "empty.txt", credentials, fetcher)).toEqual({
    size: 0, truncated: false, binary: false, content: "", contentType: "text/plain", maxBytes: 262144,
  });
  expect(requests).toBe(1);
});
