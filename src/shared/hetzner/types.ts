// --- Normalized Hetzner resource types ---

export type CloudServer = {
  providerId: string;
  ipv4: string;
  ipv6: string;
  /** Private network IPv4 Hetzner assigned at create time. Empty when the
   *  server isn't attached to the OCD network. */
  routingAddress?: string;
  status: string;
};

export type ServerType = {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  locations: string[];
};

export type VolumeInfo = {
  providerId: string;
  name: string;
  sizeGb: number;
  location: string;
  serverId: string | null;
};
