import db from "./connection.ts";

export type CiRunnerRow = {
  id: number; server_id: number; name: string; github_name: string; repository: string; status: string;
  scope: "repository" | "organization"; runner_group_id: number | null; runner_group_name: string;
  shared_builds: number; host_reserved: number; registered_at: string | null; job_timeout_seconds: number;
  draining: number; github_runner_id: number | null; runner_version: string;
  last_error: string; last_checked_at: string | null; created_at: string;
};
export type RequiredCiCheck = { name: string; app_id: number };
export type CiCheckPolicy = { checks: RequiredCiCheck[]; timeout_seconds: number };
export function getCiRunners(): CiRunnerRow[] {
  return db.query("SELECT * FROM ci_runners ORDER BY id").all() as CiRunnerRow[];
}
export function getCiRunner(id: number): CiRunnerRow | null {
  return db.query("SELECT * FROM ci_runners WHERE id=?").get(id) as CiRunnerRow | null;
}
export function getCiRunnerByServerId(id: number): CiRunnerRow | null {
  return db.query("SELECT * FROM ci_runners WHERE server_id=?").get(id) as CiRunnerRow | null;
}
export function insertCiRunner(serverId: number, name: string, repository: string, organizationGroup?: { id: number; name: string }, sharedBuilds = false, jobTimeoutSeconds = 1800): CiRunnerRow {
  return db.query("INSERT INTO ci_runners (server_id,name,github_name,repository,scope,runner_group_id,runner_group_name,shared_builds,job_timeout_seconds) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *").get(serverId, name, `ocd-ci-${crypto.randomUUID()}`, repository, organizationGroup ? "organization" : "repository", organizationGroup?.id ?? null, organizationGroup?.name ?? "", sharedBuilds ? 1 : 0, jobTimeoutSeconds) as CiRunnerRow;
}
export function updateCiRunner(id: number, fields: Partial<Pick<CiRunnerRow, "status" | "draining" | "github_runner_id" | "runner_version" | "last_error" | "last_checked_at" | "host_reserved" | "registered_at">>): void {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  db.query(`UPDATE ci_runners SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`).run(...entries.map(([, value]) => value!), id);
}
export function deleteCiRunner(id: number): void { db.query("DELETE FROM ci_runners WHERE id=?").run(id); }
export function getCiCheckPolicy(sourceId: number): CiCheckPolicy | null {
  const row = db.query("SELECT * FROM ci_check_policies WHERE source_id=?").get(sourceId) as { checks_json: string; timeout_seconds: number } | null;
  return row ? { checks: JSON.parse(row.checks_json), timeout_seconds: row.timeout_seconds } : null;
}
export function setCiCheckPolicy(sourceId: number, policy: CiCheckPolicy): void {
  db.query(`INSERT INTO ci_check_policies (source_id,checks_json,timeout_seconds) VALUES (?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET checks_json=excluded.checks_json,timeout_seconds=excluded.timeout_seconds`)
    .run(sourceId, JSON.stringify(policy.checks), policy.timeout_seconds);
}

/** Durable admission fence: no expiry can admit a build over an orphaned CI job. */
export function tryReserveCiHost(id: number): boolean {
  return db.transaction(() => {
    const runner = getCiRunner(id);
    if (!runner) return false;
    if (runner.host_reserved) return true;
    if (runner.shared_builds && hasBuildCapacityWaiters()) return false;
    if (runner.shared_builds && !db.query("SELECT 1 FROM build_workers WHERE server_id=? AND status='online' AND draining=0").get(runner.server_id)) return false;
    const busy = db.query(`SELECT 1 FROM build_worker_leases l JOIN build_workers w ON w.id=l.worker_id
      WHERE w.server_id=? AND unixepoch(l.expires_at)>unixepoch('now')`).get(runner.server_id);
    if (busy) return false;
    db.query("UPDATE ci_runners SET host_reserved=1 WHERE id=?").run(id);
    return true;
  })();
}
export function hasBuildCapacityWaiters(): boolean {
  return !!db.query(`SELECT 1 FROM operation_steps s JOIN operations o ON o.id=s.op_id
    WHERE o.status='running' AND s.status='executing' AND s.detail LIKE 'Waiting for build worker%' LIMIT 1`).get();
}
