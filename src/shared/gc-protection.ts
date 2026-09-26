import * as db from "./db.ts";
import { listPendingOperations, listRunningOperations, listCompensationFailedOperationIds } from "./db/operations.ts";

/** Use the same DB-backed protection set for manual and automatic host GC. */
export function serverGcProtections(serverId: number) {
  const placed = db.getApps(serverId).map((app) => app.name);
  const sleeping = db.getApps()
    .filter((app) => app.sleeping_server_id === serverId)
    .map((app) => app.name);
  const protectedImageRefs = db.getPanel()?.server_id === serverId
    ? db.getPanelDeployments()
      .filter((deployment) => deployment.status === "deployed")
      .slice(0, 2)
      .map((deployment) => deployment.image_tag)
    : [];
  const activeOperationIds = [...new Set([
    ...listPendingOperations(10_000).map((operation) => operation.id),
    ...listRunningOperations().map((operation) => operation.id),
    // A failed rollback still needs its remote environment snapshot for
    // operator recovery. Do not let host GC erase the only restore point.
    ...listCompensationFailedOperationIds(),
  ])];
  return {
    activeAppNames: [...new Set([...placed, ...sleeping])],
    protectedImageRefs,
    activeOperationIds,
  };
}
