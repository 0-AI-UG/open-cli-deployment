// Shared Traefik constants and pure name/port helpers. Both halves of the
// ingress stack depend on these: traefik-provision.ts (bash static-config /
// systemd / install generators) and traefik-render.ts (desired-state + dynamic
// YAML render). Kept dependency-light so neither half has to import the other.

/** Pinned Traefik release installed on the panel server (the only server that
 *  runs Traefik). v3.5+ is required for TCP server health checks
 *  (`tcp.services.*.loadBalancer.healthCheck`), which replace Caddy's passive
 *  checks for health_check=0 apps. */
export const TRAEFIK_VERSION = "3.7.7";

export const TRAEFIK_STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
/** JSON access log, one line per request. Rotated by logrotate (see
 *  traefikInstallScript) so a busy fleet never fills the disk. */
export const TRAEFIK_ACCESS_LOG_PATH = "/var/log/traefik/access.log";
export const TRAEFIK_LOGROTATE_PATH = "/etc/logrotate.d/ocd-traefik";
export const TRAEFIK_UNIT_PATH = "/etc/systemd/system/ocd-traefik.service";
export const TRAEFIK_DYNAMIC_DIR = "/etc/traefik/dynamic";
export const TRAEFIK_DYNAMIC_CONFIG_PATH = `${TRAEFIK_DYNAMIC_DIR}/ocd.yml`;
export const TRAEFIK_PANEL_CONFIG_PATH = `${TRAEFIK_DYNAMIC_DIR}/panel.yml`;
export const TRAEFIK_ACME_PATH = "/etc/traefik/acme.json";
