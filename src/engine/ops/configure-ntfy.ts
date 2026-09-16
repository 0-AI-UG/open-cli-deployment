import { registerOp } from "./registry.ts";
import type { OpKindDefinition } from "../types.ts";
import { reconcileNtfyService } from "../ntfy/service.ts";
const definition: OpKindDefinition<Record<string, never>> = {
  kind: "configure_ntfy", label: "Configure shared ntfy", resourceKeys: () => ["service:ntfy"],
  steps: [{ name: "reconcile", label: "Provision ntfy and private topic access", async run() {
    await reconcileNtfyService(); return { ok: true };
  } }],
};
registerOp(definition as OpKindDefinition<any>);
export default definition;
