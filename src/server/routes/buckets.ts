import { storageConnection, getProviderConnections } from "../../shared/provider-connections.ts";
import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
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
    await requirePermission(request, "resources.view");
    const connection = storageConnection(new URL(request.url).searchParams.get("storage") || undefined);
    const credentials = connection ? await getS3Credentials(connection.id) : null;
    if (!credentials) {
      return Response.json(
        { configured: false, buckets: [], connections: getProviderConnections().filter(p => p.kind === "s3-compatible").map(p => ({ id: p.id, name: p.name, ...p.config })) },
        { headers: corsHeaders },
      );
    }
    return Response.json(
      { configured: true, connection_id: connection!.id, connections: getProviderConnections().filter(p => p.kind === "s3-compatible").map(p => ({ id: p.id, name: p.name, ...p.config })), region: credentials.region, buckets: (await listBuckets(credentials)).map(b => ({ ...b, connection_id: connection!.id })) },
      { headers: corsHeaders },
    );
  } catch (error) {
    return providerError(error);
  }
}

export async function handleCreateBucket(request: Request): Promise<Response> {
  try {
    const payload = await requirePermission(request, "buckets.create");
    const body = await request.json() as { name?: unknown };
    const checked = validateBucketName(typeof body.name === "string" ? body.name : "");
    if (!checked.valid) {
      return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
    }
    const connection = storageConnection(new URL(request.url).searchParams.get("storage") || undefined);
    const credentials = connection ? await getS3Credentials(connection.id) : null;
    if (!credentials) {
      return Response.json(
        { error: "S3-compatible object storage is not configured. Add and assign a provider in Admin → Providers." },
        { status: 409, headers: corsHeaders },
      );
    }
    await enforceConfirmation(request, payload, "create_bucket", "bucket", `${connection!.id}:${checked.value}`);
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
    const payload = await requirePermission(request, "buckets.delete");
    const checked = validateBucketName(rawName);
    if (!checked.valid) {
      return Response.json({ error: checked.error }, { status: 400, headers: corsHeaders });
    }
    const connection = storageConnection(new URL(request.url).searchParams.get("storage") || undefined);
    const credentials = connection ? await getS3Credentials(connection.id) : null;
    if (!credentials) {
      return Response.json({ error: "S3-compatible object storage is not configured" }, { status: 409, headers: corsHeaders });
    }
    await enforceConfirmation(request, payload, "delete_bucket", "bucket", `${connection!.id}:${checked.value}`);
    await deleteBucket(checked.value, credentials);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}

function bucketContext(request: Request, rawName: string) {
  const checked = validateBucketName(rawName);
  if (!checked.valid || checked.value !== rawName) return { error: checked.valid ? "Invalid bucket name" : checked.error } as const;
  const connection = storageConnection(new URL(request.url).searchParams.get("storage") || undefined);
  return { bucket: checked.value, connection } as const;
}

export async function handleGetBucket(request: Request, rawName: string): Promise<Response> {
  try {
    await requirePermission(request, "resources.view");
    const context = bucketContext(request, rawName);
    if ("error" in context) return Response.json({ error: context.error }, { status: 400, headers: corsHeaders });
    const credentials = context.connection ? await getS3Credentials(context.connection.id) : null;
    if (!credentials) return Response.json({ error: "S3-compatible object storage is not configured" }, { status: 409, headers: corsHeaders });
    return Response.json({
      name: context.bucket,
      connection_id: context.connection!.id,
      connection_name: context.connection!.name,
      region: credentials.region,
      endpoint: credentials.endpoint,
    }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}

export async function handleListBucketObjects(request: Request, rawName: string): Promise<Response> {
  try {
    await requirePermission(request, "buckets.objects.read");
    const context = bucketContext(request, rawName);
    if ("error" in context) return Response.json({ error: context.error }, { status: 400, headers: corsHeaders });
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") || "";
    const cursor = url.searchParams.get("cursor") || undefined;
    if (Buffer.byteLength(prefix) > 1024 || prefix.includes("\0")) {
      return Response.json({ error: "Invalid object prefix" }, { status: 400, headers: corsHeaders });
    }
    const credentials = context.connection ? await getS3Credentials(context.connection.id) : null;
    if (!credentials) return Response.json({ error: "S3-compatible object storage is not configured" }, { status: 409, headers: corsHeaders });
    const page = await listObjects(context.bucket, prefix, credentials, cursor);
    return Response.json({ prefix, ...page }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}

export async function handleGetBucketObject(request: Request, rawName: string): Promise<Response> {
  try {
    await requirePermission(request, "buckets.objects.read");
    const context = bucketContext(request, rawName);
    if ("error" in context) return Response.json({ error: context.error }, { status: 400, headers: corsHeaders });
    const key = new URL(request.url).searchParams.get("key") || "";
    if (!key || Buffer.byteLength(key) > 1024 || key.includes("\0")) {
      return Response.json({ error: "Valid object key required" }, { status: 400, headers: corsHeaders });
    }
    const credentials = context.connection ? await getS3Credentials(context.connection.id) : null;
    if (!credentials) return Response.json({ error: "S3-compatible object storage is not configured" }, { status: 409, headers: corsHeaders });
    const preview = await getObjectPreview(context.bucket, key, credentials);
    return Response.json({ key, ...preview }, { headers: corsHeaders });
  } catch (error) {
    return providerError(error);
  }
}
