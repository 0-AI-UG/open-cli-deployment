export const ROLLOUT_MIN_FREE_BYTES = 5 * 1024 ** 3;

/** Metrics are advisory for placement. The runtime pull checks the host again. */
export function metricHasRolloutSpace(metric: { disk_used_gb: number; disk_total_gb: number } | undefined): boolean {
  if (!metric || metric.disk_total_gb <= 0) return true;
  return (metric.disk_total_gb - metric.disk_used_gb) * 1024 ** 3 >= ROLLOUT_MIN_FREE_BYTES;
}
