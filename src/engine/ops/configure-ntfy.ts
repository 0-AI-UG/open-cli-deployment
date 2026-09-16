import { registerOp } from "./registry.ts";
import type { OpKindDefinition } from "../types.ts";
import { reconcileNtfyService, ntfyEnvironment } from "../ntfy/service.ts";
import { ntfyDeployRequest } from "../ntfy/app.ts";
import { ntfySettings, NTFY_IMAGE } from "../../shared/ntfy.ts";
import { resolveOciImage } from "../oci-image.ts";
import { processIncomingEnvVars } from "../../shared/env-crypto.ts";
import * as db from "../../shared/db.ts";
import { enqueueOperation, listChildOperations } from "../../shared/db/operations.ts";
import { awaitChildren } from "./_children.ts";
export type ConfigureNtfyInput = { create?: { name: string; domain: string; server_id: number } };
const definition: OpKindDefinition<ConfigureNtfyInput> = {
  kind: "configure_ntfy", label: "Configure notification integration", resourceKeys: () => ["service:ntfy"],
  steps: [{ name: "configure", label: "Configure ntfy app integration", async run(ctx) {
    const settings = ntfySettings();
    if (!settings) return { ok: true };
    if (ctx.input.create) {
      const input = ctx.input.create;
      let deployment = listChildOperations(ctx.opId).find(op => op.kind === "deploy");
      if (!deployment) {
        if (db.getAppByName(input.name)) throw new Error("An app with that name already exists");
        const image = await resolveOciImage(NTFY_IMAGE);
        const values = await ntfyEnvironment(settings, input.domain);
        const name = `${input.name}-${ctx.opId}`;
        let environment = db.getEnvironments().find(e => e.name === name);
        if (!environment) environment = db.insertEnvironment(name, JSON.stringify(await processIncomingEnvVars(Object.entries(values).map(([key, value]) => ({ key, value, secret: key.startsWith("NTFY_AUTH_") })))));
        deployment = enqueueOperation({ kind: "deploy", resourceKeys: [`app:create:${input.name}`], input: ntfyDeployRequest(input, environment.id, image), trigger: "ui", triggeredBy: ctx.triggeredBy, parentId: ctx.opId, idempotencyKey: `ntfy:${ctx.opId}:deploy` });
      }
      await awaitChildren(ctx, { childIds: [deployment.id] });
      const app = db.getAppByName(input.name);
      if (!app) throw new Error("ntfy deployment finished without an app");
      db.saveSetting("ntfy_settings", JSON.stringify({ ...ntfySettings(), app_id: app.id }));
    }
    await reconcileNtfyService(ctx);
    return { ok: true, appId: ntfySettings()?.app_id };
  } }],
};
registerOp(definition as OpKindDefinition<any>);
export default definition;
