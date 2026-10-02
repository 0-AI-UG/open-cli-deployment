import db from "./connection.ts";

export type ServerRow = {
  id: number;
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  ssh_host_key: string;
  /** Private-network IPv4 Hetzner assigned; used for fleet routing. */
  routing_address: string;
  provider_status: string;
  last_observed_at: string | null;
  unavailable_ticks: number;
  created_at: string;
};

export function getServers(): ServerRow[] {
  return db
    .query("SELECT * FROM servers ORDER BY created_at DESC")
    .all() as ServerRow[];
}

export function getServer(id: number): ServerRow | null {
  return db.query("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | null;
}

export function getServerByProviderId(providerId: string): ServerRow | null {
  return db
    .query("SELECT * FROM servers WHERE provider_id = ?")
    .get(providerId) as ServerRow | null;
}

export function insertServer(server: {
  name: string;
  provider_id: string;
  ipv4: string;
  ipv6: string;
  type: string;
  location: string;
  status: string;
  routing_address?: string;
}): ServerRow {
  return db
    .query(
      "INSERT INTO servers (name, provider_id, ipv4, ipv6, type, location, status, routing_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    )
    .get(
      server.name,
      server.provider_id,
      server.ipv4,
      server.ipv6,
      server.type,
      server.location,
      server.status,
      server.routing_address ?? "",
    ) as ServerRow;
}

export function updateServerStatus(id: number, status: string): void {
  db.query("UPDATE servers SET status = ? WHERE id = ?").run(status, id);
}

export function updateServer(id: number, fields: {
  provider_id?: string;
  ipv4?: string;
  ipv6?: string;
  status?: string;
  routing_address?: string;
}): void {
  const setClauses: string[] = [];
  const values: (string | number)[] = [];
  if (fields.provider_id !== undefined) { setClauses.push("provider_id = ?"); values.push(fields.provider_id); }
  if (fields.ipv4 !== undefined) { setClauses.push("ipv4 = ?"); values.push(fields.ipv4); }
  if (fields.ipv6 !== undefined) { setClauses.push("ipv6 = ?"); values.push(fields.ipv6); }
  if (fields.status !== undefined) { setClauses.push("status = ?"); values.push(fields.status); }
  if (fields.routing_address !== undefined) { setClauses.push("routing_address = ?"); values.push(fields.routing_address); }
  if (setClauses.length === 0) return;
  values.push(id);
  db.query(`UPDATE servers SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteServer(id: number): void {
  db.query("DELETE FROM servers WHERE id = ?").run(id);
}

export function updateServerHostKey(id: number, hostKey: string): void {
  db.query("UPDATE servers SET ssh_host_key = ? WHERE id = ?").run(hostKey, id);
}

export function recordServerObservation(
  id: number,
  observation: {
    providerStatus: string;
    ipv4?: string;
    ipv6?: string;
    routingAddress?: string;
    available: boolean;
  },
): void {
  db.query(
    `UPDATE servers
       SET provider_status = ?, last_observed_at = datetime('now'),
           unavailable_ticks = CASE WHEN ? THEN 0 ELSE unavailable_ticks + 1 END,
           ipv4 = COALESCE(?, ipv4), ipv6 = COALESCE(?, ipv6),
           routing_address = COALESCE(?, routing_address)
     WHERE id = ?`,
  ).run(
    observation.providerStatus,
    observation.available ? 1 : 0,
    observation.ipv4 ?? null,
    observation.ipv6 ?? null,
    observation.routingAddress ?? null,
    id,
  );
}

// --- Server-level metrics ---

export type ServerMetricSampleRow = {
  id: number;
  server_id: number;
  cpu_percent: number;
  memory_percent: number;
  disk_used_gb: number;
  disk_total_gb: number;
  sampled_at: string;
};

export function insertServerMetricSample(
  serverId: number,
  cpuPercent: number,
  memPercent: number,
  diskUsedGb = 0,
  diskTotalGb = 0,
): void {
  db.query(
    "INSERT INTO server_metrics_samples (server_id, cpu_percent, memory_percent, disk_used_gb, disk_total_gb) VALUES (?, ?, ?, ?, ?)"
  ).run(serverId, cpuPercent, memPercent, diskUsedGb, diskTotalGb);
}

export function getRecentServerMetrics(sinceSeconds: number): Pick<ServerMetricSampleRow, "server_id" | "cpu_percent" | "memory_percent" | "disk_used_gb" | "disk_total_gb" | "sampled_at">[] {
  return db
    .query(
      `SELECT server_id, cpu_percent, memory_percent, disk_used_gb, disk_total_gb, sampled_at
       FROM server_metrics_samples
       WHERE sampled_at >= datetime('now', ?)
       ORDER BY sampled_at ASC`
    )
    .all(`-${sinceSeconds} seconds`) as Pick<ServerMetricSampleRow, "server_id" | "cpu_percent" | "memory_percent" | "disk_used_gb" | "disk_total_gb" | "sampled_at">[];
}

export function pruneOldServerMetrics(olderThanSeconds: number): void {
  db.query(
    "DELETE FROM server_metrics_samples WHERE sampled_at < datetime('now', ?)"
  ).run(`-${olderThanSeconds} seconds`);
}
