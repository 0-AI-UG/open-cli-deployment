import db, { getUserById, getApp, hasPermission } from "../../shared/db.ts";
import { requireAuthenticated } from "../lib/permissions.ts";
import { corsHeaders } from "../lib/cors.ts";
import { handleError } from "../lib/utils.ts";
import type { Incident } from "../../shared/incidents.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...corsHeaders, "cache-control": "no-store" } });
const incidentId = (request: Request) => new URL(request.url).pathname.match(/^\/api\/incidents\/([^/]+)/)?.[1] || "";
export async function handleListIncidents(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "all";
    if (!["all", "active", "resolved"].includes(status)) return json({ error: "Invalid incident filter" }, 400);
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return json({ error: "Invalid offset" }, 400);
    const rows = db.query("SELECT * FROM panel_incident_history ORDER BY first_seen DESC, incident_id DESC").all() as Incident[];
    const visible = rows.filter(row => canAccess(actor.userId, row));
    const counts = { all: visible.length, active: visible.filter(row => row.resolved_at === null).length, resolved: visible.filter(row => row.resolved_at !== null).length };
    const filtered = visible.filter(row => status === "all" || (status === "active" ? row.resolved_at === null : row.resolved_at !== null));
    return json({ incidents: filtered.slice(offset, offset + 50), nextOffset: offset + 50 < filtered.length ? offset + 50 : null, counts });
  } catch (error) { return handleError(error); }
}
function canAccess(userId: string, found: Incident): boolean {
  const user = getUserById(userId);
  if (user?.is_admin) return true;
  if (!found.key.startsWith("app:")) return false;
  const appId = Number(found.key.slice(4));
  return !!getApp(appId) && hasPermission(userId, "apps.view", { appId });
}
function canResolve(userId: string, found: Incident): boolean {
  if (getUserById(userId)?.is_admin) return true;
  return canAccess(userId, found) && hasPermission(userId, "apps.restart", { appId: Number(found.key.slice(4)) });
}
export async function handleGetIncident(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const found = db.query("SELECT * FROM panel_incident_history WHERE incident_id=?").get(incidentId(request)) as Incident | null;
    if (!found) return json({ error: "Incident not found" }, 404);
    if (!canAccess(actor.userId, found)) return json({ error: "Forbidden" }, 403);
    return json({ incident: found, canResolve: canResolve(actor.userId, found) });
  } catch (error) { return handleError(error); }
}

export async function handleResolveIncident(request: Request): Promise<Response> {
  try {
    const actor = await requireAuthenticated(request);
    const id = incidentId(request);
    const found = db.query("SELECT * FROM panel_incident_history WHERE incident_id=?").get(id) as Incident | null;
    if (!found) return json({ error: "Incident not found" }, 404);
    if (!canResolve(actor.userId, found)) return json({ error: "Forbidden" }, 403);
    // Keep the current monitoring condition intact so the same occurrence does
    // not reopen on the next tick. A recovery followed by a recurrence still opens a new incident.
    db.query("UPDATE panel_incident_history SET resolved_at=COALESCE(resolved_at,?) WHERE incident_id=?").run(Date.now(), id);
    return json({ incident: db.query("SELECT * FROM panel_incident_history WHERE incident_id=?").get(id), canResolve: true });
  } catch (error) { return handleError(error); }
}
