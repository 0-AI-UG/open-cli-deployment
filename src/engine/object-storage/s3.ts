import { createHash, createHmac } from "node:crypto";
import { secretStore } from "../../shared/secret-store.ts";


export type S3Credentials = {
  accessKey: string;
  secretKey: string;
  region: string;
  endpoint: string;
};

export type S3Bucket = {
  name: string;
  createdAt: string;
  region: string;
  endpoint: string;
};

export type S3Object = {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
};

export type S3ObjectPage = {
  prefixes: string[];
  objects: S3Object[];
  nextCursor: string | null;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function amzDate(now: Date): { timestamp: string; date: string } {
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { timestamp, date: timestamp.slice(0, 8) };
}

export function isS3Region(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

export function isS3Endpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validateBucketName(raw: string): { valid: true; value: string } | { valid: false; error: string } {
  const value = raw.trim().toLowerCase();
  if (value.length < 3 || value.length > 63) {
    return { valid: false, error: "Bucket name must be between 3 and 63 characters" };
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)) {
    return { valid: false, error: "Bucket name must start and end with a letter or digit and contain only lowercase letters, digits, dots, or hyphens" };
  }
  if (value.includes("..") || value.includes(".-") || value.includes("-.")) {
    return { valid: false, error: "Bucket name contains an invalid dot sequence" };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return { valid: false, error: "Bucket name must not look like an IPv4 address" };
  }
  return { valid: true, value };
}

export function signS3Request(opts: {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  path: string;
  credentials: S3Credentials;
  body?: string | Uint8Array;
  now?: Date;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}): { url: string; headers: Record<string, string> } {
  const now = opts.now ?? new Date();
  const { timestamp, date } = amzDate(now);
  const body = opts.body ?? "";
  const payloadHash = sha256(body);
  const endpoint = new URL(opts.credentials.endpoint);
  const canonicalUri = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const encodeQueryPart = (value: string) => encodeURIComponent(value)
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = Object.entries(opts.query ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => [encodeQueryPart(key), encodeQueryPart(String(value))] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const normalizedExtraHeaders = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value.trim()]),
  );
  const headers: Record<string, string> = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
    ...normalizedExtraHeaders,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${opts.credentials.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${opts.credentials.secretKey}`, date);
  const regionKey = hmac(dateKey, opts.credentials.region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return { url: `${endpoint.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`, headers };
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

export function parseListBuckets(xml: string, credentials: Pick<S3Credentials, "region" | "endpoint">): S3Bucket[] {
  const buckets: S3Bucket[] = [];
  for (const match of xml.matchAll(/<Bucket(?:\s[^>]*)?>([\s\S]*?)<\/Bucket>/gi)) {
    const name = xmlTag(match[1], "Name");
    if (!name) continue;
    buckets.push({
      name,
      createdAt: xmlTag(match[1], "CreationDate"),
      region: credentials.region,
      endpoint: credentials.endpoint,
    });
  }
  return buckets.sort((a, b) => a.name.localeCompare(b.name));
}

export class S3Error extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

async function s3Request(
  method: "GET" | "PUT" | "DELETE" | "HEAD",
  path: string,
  credentials: S3Credentials,
  opts: { body?: string | Uint8Array; headers?: Record<string, string>; query?: Record<string, string | number | undefined>; fetcher?: typeof fetch } = {},
): Promise<Response> {
  const signed = signS3Request({ method, path, credentials, body: opts.body, headers: opts.headers, query: opts.query });
  const signal = AbortSignal.timeout(120_000);
  const response = await (opts.fetcher ?? fetch)(signed.url, {
    method,
    headers: signed.headers,
    body: method === "PUT" && opts.body ? (typeof opts.body === "string" ? opts.body : new Uint8Array(opts.body)) : undefined,
    signal,
    redirect: "error",
  });
  if (response.ok) return response;
  const xml = await response.text();
  const code = xmlTag(xml, "Code") || `HTTP_${response.status}`;
  const providerMessage = xmlTag(xml, "Message");
  const message = code === "BucketNotEmpty"
    ? "Bucket is not empty. OCD never recursively deletes objects; remove every object and version first."
    : code === "AccessDenied"
      ? "Access denied. Check the S3 credentials and bucket policy."
      : code === "InvalidAccessKeyId" || code === "SignatureDoesNotMatch"
        ? "Invalid S3 credentials."
        : providerMessage || `S3 request failed (${response.status})`;
  throw new S3Error(message, response.status, code);

}

export async function getS3Credentials(connectionId?: string): Promise<S3Credentials | null> {
  const { storageConnection, providerSecretKey } = await import("../../shared/provider-connections.ts");
  const provider = storageConnection(connectionId);
  if (!provider || provider.kind !== "s3-compatible") return null;
  const [accessKey, secretKey] = await Promise.all([
    secretStore.get(providerSecretKey(provider.id, "access_key")),
    secretStore.get(providerSecretKey(provider.id, "secret_key")),
  ]);
  const region = provider.config.region ?? "";
  const endpoint = provider.config.endpoint ?? "";
  if (!accessKey || !secretKey || !isS3Region(region) || !isS3Endpoint(endpoint)) return null;
  return { accessKey, secretKey, region, endpoint };
}

export async function listBuckets(
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<S3Bucket[]> {
  const response = await s3Request("GET", "/", credentials, { fetcher });
  return parseListBuckets(await response.text(), credentials);
}

export async function createBucket(
  name: string,
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<void> {
  const checked = validateBucketName(name);
  if (!checked.valid) throw new Error(checked.error);
  await s3Request("PUT", `/${encodeURIComponent(checked.value)}`, credentials, {
    headers: { "x-amz-acl": "private" },
    fetcher,
  });
}

export async function deleteBucket(
  name: string,
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<void> {
  const checked = validateBucketName(name);
  if (!checked.valid) throw new Error(checked.error);
  await s3Request("DELETE", `/${encodeURIComponent(checked.value)}`, credentials, { fetcher });
}

export function parseListObjects(xml: string, prefix: string): S3ObjectPage {
  const prefixes = [...xml.matchAll(/<CommonPrefixes(?:\s[^>]*)?>([\s\S]*?)<\/CommonPrefixes>/gi)]
    .map(match => xmlTag(match[1], "Prefix"))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const objects: S3Object[] = [];
  for (const match of xml.matchAll(/<Contents(?:\s[^>]*)?>([\s\S]*?)<\/Contents>/gi)) {
    const key = xmlTag(match[1], "Key");
    if (!key || key === prefix || key.endsWith("/")) continue;
    objects.push({
      key,
      size: Number(xmlTag(match[1], "Size")) || 0,
      lastModified: xmlTag(match[1], "LastModified"),
      etag: xmlTag(match[1], "ETag").replace(/^"|"$/g, ""),
    });
  }
  objects.sort((a, b) => a.key.localeCompare(b.key));
  return {
    prefixes,
    objects,
    nextCursor: xmlTag(xml, "IsTruncated").toLowerCase() === "true"
      ? xmlTag(xml, "NextContinuationToken") || null
      : null,
  };
}

export async function listObjects(
  bucket: string,
  prefix: string,
  credentials: S3Credentials,
  cursor?: string,
  fetcher?: typeof fetch,
): Promise<S3ObjectPage> {
  const checked = validateBucketName(bucket);
  if (!checked.valid || checked.value !== bucket) throw new Error("Invalid bucket name");
  const response = await s3Request("GET", `/${encodeURIComponent(bucket)}`, credentials, {
    query: {
      "list-type": "2",
      delimiter: "/",
      prefix,
      "max-keys": 1000,
      "continuation-token": cursor || undefined,
    },
    fetcher,
  });
  return parseListObjects(await response.text(), prefix);
}

function objectPath(bucket: string, key: string): string {
  const checked = validateBucketName(bucket);
  if (!checked.valid || checked.value !== bucket) throw new Error("Invalid bucket name");
  if (!key || key.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid object key");
  return `/${bucket}/${key.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
}

export async function putObject(bucket: string, key: string, body: Uint8Array, credentials: S3Credentials): Promise<void> {
  await s3Request("PUT", objectPath(bucket, key), credentials, { body, headers: { "content-type": "application/octet-stream" } });
}
export async function getObject(bucket: string, key: string, credentials: S3Credentials): Promise<Buffer> {
  const response = await s3Request("GET", objectPath(bucket, key), credentials);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty S3 response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024 * 1024) throw new Error("Backup object exceeds 512 MiB limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }

}

export const OBJECT_PREVIEW_MAX_BYTES = 256 * 1024;

export async function getObjectPreview(
  bucket: string,
  key: string,
  credentials: S3Credentials,
  fetcher?: typeof fetch,
): Promise<{ size: number; truncated: boolean; binary: boolean; content: string | null; contentType: string; maxBytes: number }> {
  const head = await s3Request("HEAD", objectPath(bucket, key), credentials, { fetcher });
  const size = Number(head.headers.get("content-length")) || 0;
  const contentType = head.headers.get("content-type") || "application/octet-stream";
  if (size === 0) {
    return { size: 0, truncated: false, binary: false, content: "", contentType, maxBytes: OBJECT_PREVIEW_MAX_BYTES };
  }
  const response = await s3Request("GET", objectPath(bucket, key), credentials, {
    headers: { range: `bytes=0-${Math.min(size, OBJECT_PREVIEW_MAX_BYTES) - 1}` },
    fetcher,
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty S3 response");
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < OBJECT_PREVIEW_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = OBJECT_PREVIEW_MAX_BYTES - received;
      chunks.push(value.subarray(0, remaining));
      received += Math.min(value.length, remaining);
    }
  } finally {
    await reader.cancel();
  }
  const raw = Buffer.concat(chunks);
  const truncated = size > OBJECT_PREVIEW_MAX_BYTES;
  const binary = raw.includes(0);
  return {
    size,
    truncated,
    binary,
    content: binary ? null : raw.toString("utf8"),
    contentType,
    maxBytes: OBJECT_PREVIEW_MAX_BYTES,
  };
}
export async function deleteObject(bucket: string, key: string, credentials: S3Credentials): Promise<void> {
  await s3Request("DELETE", objectPath(bucket, key), credentials);
}
