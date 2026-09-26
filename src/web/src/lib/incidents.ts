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
  };
  if (key.startsWith("disk:")) return {
    category: "Server disk", linkLabel: "Open server",
    condition: "Disk usage reached 85% or free space fell below 5 GB for at least two minutes.",
  };
  if (key.startsWith("delivery:")) return {
    category: "Deployment", linkLabel: "Open failed operation",
    condition: "A deployment operation failed. The target is awaiting a successful delivery.",
  };
  if (key.startsWith("backup:")) return {
    category: "Panel backup", linkLabel: "Open admin → Panel",
    condition: key === "backup:overdue" ? "No successful scheduled panel backup was recorded within the expected 26-hour window." : "The latest completed panel backup attempt failed.",
  };
  return {
    category: "Operations", linkLabel: "Open affected resource",
    condition: "Monitoring detected a condition that needs attention.",
  };
}
