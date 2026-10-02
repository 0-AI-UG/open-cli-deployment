import type { StorageDriver } from "./contracts.ts";
import { hetznerVolumeStorage } from "./hetzner-volume.ts";
import { localDirectoryStorage } from "./local-directory.ts";

/** Hetzner volumes are the default. Server-local directories remain for
 *  volumes that were created on a host's own disk. */
const drivers = new Map<string, StorageDriver>(
  [hetznerVolumeStorage, localDirectoryStorage].map((driver) => [driver.id, driver]),
);

export function requireStorageDriver(id: string): StorageDriver {
  const driver = drivers.get(id);
  if (!driver) throw new Error(`Unknown storage driver: ${id || "(empty)"}`);
  return driver;
}

export function defaultStorageDriver(): StorageDriver {
  return requireStorageDriver("hetzner-block");
}

export type { StorageDriver, StorageVolume } from "./contracts.ts";
