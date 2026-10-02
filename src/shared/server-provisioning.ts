export type ServerProvisioningPlan = {
  serverType: string;
  location: string;
  reason: string;
};

/** Stable resource identity used to bind browser approval to one exact
 * explicitly requested server (`ocd servers create`). Arrays keep the encoding
 * compact and deterministic. */
export function serverProvisioningResourceId(plan: ServerProvisioningPlan): string {
  return JSON.stringify([plan.serverType, plan.location, plan.reason]);
}

export function parseServerProvisioningResourceId(resourceId: string): ServerProvisioningPlan | null {
  try {
    const parsed = JSON.parse(resourceId) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [serverType, location, reason] = parsed;
    if (
      typeof serverType !== "string" || !serverType ||
      typeof location !== "string" || !location ||
      typeof reason !== "string" || !reason
    ) return null;
    return { serverType, location, reason };
  } catch {
    return null;
  }
}
