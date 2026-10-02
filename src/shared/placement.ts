/**
 * Explicit per-server placement. The user declares exactly which servers run
 * an app and how many replicas each one runs; OCD never picks servers or
 * replica counts on its own.
 *
 * Two shapes exist:
 *  - a placement *spec* as written in a manifest: server name or numeric server
 *    id -> replica count;
 *  - a *resolved* placement as stored in `apps.placement`: numeric server id
 *    (as a string key) -> replica count.
 *
 * Pure and dependency-free so the CLI bundle, the panel routes and the engine
 * all share one implementation.
 */

export type PlacementSpec = Record<string, number>;
/** Resolved placement keyed by numeric server id (string keys, JSON-friendly). */
export type Placement = Record<string, number>;

type PlacementServer = { id: number; name: string };

/** Structural check shared by every entry point: at least one server, every
 * count a positive integer. Returns an error message or null. */
export function placementShapeError(spec: unknown): string | null {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return "Placement must be an object mapping server name -> replica count";
  }
  const entries = Object.entries(spec as Record<string, unknown>);
  if (entries.length === 0) return "Placement must name at least one server";
  for (const [server, count] of entries) {
    if (!server.trim()) return "Placement server names must be non-empty";
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      return `Placement for server "${server}" must be an integer >= 1`;
    }
  }
  return null;
}

/** Apps with a volume own single-writer state: exactly one server, one replica. */
export function volumePlacementError(spec: PlacementSpec): string | null {
  const entries = Object.values(spec);
  if (entries.length !== 1 || entries[0] !== 1) {
    return "Apps with a volume must be placed on exactly one server with 1 replica";
  }
  return null;
}

/** Resolve a manifest placement spec (server names or ids) to server ids.
 * Every referenced server must exist; ambiguity is an error, never a guess. */
export function resolvePlacement(spec: PlacementSpec, servers: PlacementServer[]): Placement {
  const shape = placementShapeError(spec);
  if (shape) throw new Error(shape);
  const resolved: Placement = {};
  for (const [ref, count] of Object.entries(spec)) {
    const server = resolvePlacementServer(ref, servers);
    const key = String(server.id);
    if (resolved[key] !== undefined) {
      throw new Error(`Placement names server ${server.name} (#${server.id}) more than once`);
    }
    resolved[key] = count;
  }
  return normalizePlacement(resolved);
}

function resolvePlacementServer(ref: string, servers: PlacementServer[]): PlacementServer {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) {
    const byId = servers.find((server) => server.id === Number(trimmed));
    if (byId) return byId;
  }
  const byName = servers.filter((server) => server.name.toLowerCase() === trimmed.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Placement server "${ref}" is ambiguous; use its numeric id (${byName.map((s) => `#${s.id}`).join(", ")})`);
  }
  throw new Error(`Placement server "${ref}" does not exist. Run \`ocd servers\` to list servers.`);
}

/** Canonical key order (ascending server id) so equal placements serialize equally. */
export function normalizePlacement(placement: Placement): Placement {
  return Object.fromEntries(
    Object.entries(placement)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => Number(a) - Number(b)),
  );
}

export function parsePlacement(raw: string | null | undefined): Placement {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Placement = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^\d+$/.test(key) && typeof value === "number" && Number.isInteger(value) && value > 0) out[key] = value;
    }
    return normalizePlacement(out);
  } catch {
    return {};
  }
}

export function serializePlacement(placement: Placement): string {
  return JSON.stringify(normalizePlacement(placement));
}

export function placementTotal(placement: Placement): number {
  return Object.values(placement).reduce((sum, count) => sum + count, 0);
}

export function placementServerIds(placement: Placement): number[] {
  return Object.keys(normalizePlacement(placement)).map(Number);
}

/** Human-readable `name×count, …` rendering for logs and errors. */
export function describePlacement(placement: Placement, servers: PlacementServer[]): string {
  return Object.entries(normalizePlacement(placement)).map(([id, count]) => {
    const name = servers.find((server) => server.id === Number(id))?.name ?? `#${id}`;
    return `${name}×${count}`;
  }).join(", ");
}
