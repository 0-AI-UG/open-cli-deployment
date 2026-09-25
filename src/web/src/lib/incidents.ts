import type { Incident } from "../../../shared/incidents.ts";

export const incidentDate = (value: number | null) => value === null ? "—" : new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function incidentDuration(incident: Incident, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor(((incident.resolved_at ?? now) - (incident.opened_at ?? incident.first_seen)) / 1000));
  if (seconds < 60) return "Less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function incidentGuide(key: string) {
  if (key.startsWith("app:")) return {
    category: "App health", linkLabel: "Open app",
    condition: "The app remained unhealthy beyond the two-minute grace period.",
    steps: ["Open the app and inspect replica health and recent logs for startup errors, crashes, or failed health checks.", "Compare the latest deployment and configuration with the last healthy version. Check dependency connectivity and available memory.", "Correct the underlying issue, or use the app’s deployment controls to restore a known working version."],
    recovery: "The incident clears when the app is no longer reported as unhealthy.",
  };
  if (key.startsWith("disk:")) return {
    category: "Server disk", linkLabel: "Open server",
    condition: "Disk usage reached 85% or free space fell below 5 GB for at least two minutes.",
    steps: ["Open the server and check its current disk usage and whether metrics are recent.", "Inspect container images, logs, and volumes to identify what is consuming space. Preserve application data and backups.", "Free unused storage or increase capacity, then check a fresh disk sample."],
    recovery: "Recovery requires a fresh sample showing usage below 85% and at least 5 GB free. Missing metrics do not count as recovery.",
  };
  if (key.startsWith("delivery:")) return {
    category: "Deployment", linkLabel: "Open failed operation",
    condition: "A deployment operation failed. The target is awaiting a successful delivery.",
    steps: ["Open the failed operation and inspect the failing step and its logs.", "Check the source, image, configuration, and infrastructure indicated by that error. A failed deployment does not necessarily mean the serving app is down.", "Correct the cause and retry the deployment through the affected resource’s controls. Verify the new operation completes successfully."],
    recovery: "A later successful delivery for the same deployment target clears this incident.",
  };
  if (key.startsWith("backup:")) return {
    category: "Panel backup", linkLabel: "Open admin → Panel",
    condition: key === "backup:overdue" ? "No successful scheduled panel backup was recorded within the expected 26-hour window." : "The latest completed panel backup attempt failed.",
    steps: ["Open Admin → Panel and inspect the backup history and the latest failure details.", "Check the backup schedule, object-storage connection, credentials, and destination availability.", "Run a new backup and verify it completes successfully."],
    recovery: key === "backup:overdue" ? "A successful backup clears the overdue condition. Disabling the backup schedule also stops overdue monitoring." : "A verified successful backup clears the failure. Starting a retry alone does not clear it.",
  };
  return {
    category: "Operations", linkLabel: "Open affected resource",
    condition: "Monitoring detected a condition that needs attention.",
    steps: ["Open the affected resource and inspect its status and recent logs.", "Correct the reported issue and verify the resource’s health."],
    recovery: "The incident clears when monitoring no longer detects the condition.",
  };
}
