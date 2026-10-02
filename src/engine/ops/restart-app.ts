import { makeAppLifecycleOp, type AppLifecycleInput } from "./app-lifecycle.ts";

const restartAppOp = makeAppLifecycleOp({
  kind: "restart_app",
  label: "Restart app",
  actionName: "restart_replicas",
  actionLabel: "Restart replicas",
  // Restart only makes sense for live apps. Paused/destroying apps are
  // explicitly NOT restarted — caller should unpause first.
  shouldSkip: (app) =>
    app.status === "paused" ||
    app.status === "destroying" ||
    app.status === "cleanup_failed" ||
    app.status === "deploying",
  skipLog: (app) => `app ${app.name} status='${app.status}' — restart skipped`,
  action: "restart",
  requireReplicas: true,
});

export default restartAppOp;
export type RestartAppInput = AppLifecycleInput;
