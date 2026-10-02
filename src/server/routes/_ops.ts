import { corsHeaders } from "../lib/cors.ts";
import { requirePermission } from "../lib/permissions.ts";
import { handleError } from "../lib/utils.ts";
import { enqueue } from "../ipc/enqueue.ts";

/** Shared tail for the many near-identical "check permission, enqueue an op,
 *  return its op_id" route handlers. CLI and UI callers intentionally share
 *  this path; only operation provenance differs. */
export async function enqueueOp(
  request: Request,
  opts: {
    permission: string;
    kind: string;
    resourceKeys: string[];
    input: unknown;
    body?: (opId: number) => Record<string, unknown>;
  },
): Promise<Response> {
  try {
    const payload = await requirePermission(request, opts.permission);
    const { opId } = enqueue({
      kind: opts.kind,
      resourceKeys: opts.resourceKeys,
      input: opts.input,
      trigger: payload.client === "cli" ? "cli" : "ui",
      triggeredBy: payload.userId,
    });
    const body = opts.body ? opts.body(opId) : { op_id: opId };
    return Response.json(body, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
