export type StorageMount = {
  id: string;
  kind: "local-directory" | "provider-volume";
  server_id: number | null;
  server_name: string;
  app_name: string;
  host_path: string;
  container_path: string;
  state: string;
  used_bytes: number | null;
};

export function localVolumeIdentity(id: string) {
  const match = /^local:(\d+):([a-z0-9][a-z0-9-]{0,127})$/.exec(id);
  return match ? { serverId: Number(match[1]), hostPath: `/var/lib/ocd/volumes/${match[2]}` } : null;
}

export function storageUsage(bytes: number | null) {
  if (bytes == null) return "Usage unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]} used`;
}
