import { corsHeaders } from "../lib/cors.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { enforceConfirmation } from "../lib/action-confirm.ts";
import { handleError } from "../lib/utils.ts";
import {
  createBucket,
  deleteBucket,
  getS3Credentials,
  S3Error,
  getObjectPreview,
  listBuckets,
  listObjects,
  validateBucketName,
} from "../../engine/object-storage/s3.ts";

const NOT_CONFIGURED = "Hetzner Object Storage is not configured. Add its credentials in Settings → Hetzner.";

function providerError(error: unknown): Response {
  if (error instanceof S3Error) {
    const status = error.code === "BucketAlreadyExists" || error.code === "BucketAlreadyOwnedByYou"
      ? 409
      : error.code === "NoSuchBucket"
        ? 404
        : error.status === 401 || error.status === 403
          ? 403
          : error.status >= 400 && error.status < 500
            ? 400
            : 502;
    return Response.json({ error: error.message, code: error.code }, { status, headers: corsHeaders });
  }
  return handleError(error);
}

export async function handleListBuckets(request: Request): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const credentials = await getS3Credentials();
    if (!credentials) {
      return Response.json({ configured: false, buckets: [] }, { headers: corsHeaders });
    }
    return Response.json(
      { configured: true, region: credentials.region, buckets: await listBuckets(credentials) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return providerError(error);
  }
}

export async function handleCreateBucket(request: Request): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    const body = await request.json() as { name?: unknown };
    const checked = validateBucketName(typeof body.name === "string" ? body.name : "");
    if (!checked.valid) {
      return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
    }
    const credentials = await getS3Credentials();
    if (!credentials) {
      return Response.json(
        { error: NOT_CONFIGURED },
        { status: 409, headers: corsHeaders },
      );
    }
    await enforceConfirmation(request, payload, "create_bucket", "bucket", checked.value);
    await createBucket(checked.value, credentials);
    return Response.json(
      { ok: true, bucket: { name: checked.value, region: credentials.region } },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return providerError(error);
  }
}

export async function handleDeleteBucket(request: Request, rawName: string): Promise<Response> {
  try {
    const payload = await requireAuthenticated(request);
    const checked = validateBucketName(rawName);
    if (!checked.valid) {
      return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
    }
    const credentials = await getS3Credentials();
    if (!credentials) {
      return Response.json({ error: NOT_CONFIGURED }, { status: 409, headers: corsHeaders });
    }
    await enforceConfirmation(request, payload, "delete_bucket", "bucket", checked.value);
    await deleteBucket(checked.value, credentials);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}

function bucketContext(rawName: string) {
  const checked = validateBucketName(rawName);
  if (!checked.valid || checked.value !== rawName) return { error: checked.valid ? "Invalid bucket name" : checked.error } as const;
  return { bucket: checked.value } as const;
}

export async function handleGetBucket(request: Request, rawName: string): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const context = bucketContext(rawName);
    if ("error" in context) return Response.json({ error: context.error }, { status: 400, headers: corsHeaders });
    const credentials = await getS3Credentials();
    if (!credentials) return Response.json({ error: NOT_CONFIGURED }, { status: 409, headers: corsHeaders });
    return Response.json({
      name: context.bucket,
      region: credentials.region,
      endpoint: credentials.endpoint,
    }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}

export async function handleListBucketObjects(request: Request, rawName: string): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const context = bucketContext(rawName);
    if ("error" in context) return Response.json({ error: context.error }, { status: 400, headers: corsHeaders });
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") || "";
    const cursor = url.searchParams.get("cursor") || undefined;
    if (Buffer.byteLength(prefix) > 1024 || prefix.includes("\0")) {
      return Response.json({ error: "Invalid object prefix" }, { status: 400, headers: corsHeaders });
    }
    const credentials = await getS3Credentials();
    if (!credentials) return Response.json({ error: NOT_CONFIGURED }, { status: 409, headers: corsHeaders });
    const page = await listObjects(context.bucket, prefix, credentials, cursor);
    return Response.json({ prefix, ...page }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}

export async function handleGetBucketObject(request: Request, rawName: string): Promise<Response> {
  try {
    await requireAuthenticated(request);
    const context = bucketContext(rawName);
    if ("error" in context) return Response.json({ error: context.error }, { status: 400, headers: corsHeaders });
    const key = new URL(request.url).searchParams.get("key") || "";
    if (!key || Buffer.byteLength(key) > 1024 || key.includes("\0")) {
      return Response.json({ error: "Valid object key required" }, { status: 400, headers: corsHeaders });
    }
    const credentials = await getS3Credentials();
    if (!credentials) return Response.json({ error: NOT_CONFIGURED }, { status: 409, headers: corsHeaders });
    const preview = await getObjectPreview(context.bucket, key, credentials);
    return Response.json({ key, ...preview }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}
