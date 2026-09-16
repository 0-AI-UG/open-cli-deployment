import template from "../../../services/ntfy/.ocd-deploy.json";
import type { DeployRequest } from "../../shared/rpc.ts";
/** The Admin shortcut deploys the same manifest shipped under services/ntfy. */
export function ntfyDeployRequest(input: { name: string; domain: string; server_id: number }, environmentId: number, image: string): DeployRequest {
  return {
    app_name: input.name, domain: input.domain, server_id: input.server_id,
    apply_mode: "manifest", delivery_source: "image", image_ref: image,
    container_port: template.container_port, environment_id: environmentId,
    env: template.env, public: template.public, command: template.command,
    volume_driver: template.volume.driver, volume_size: template.volume.size, volume_path: template.volume.path,
    replicas: template.replicas, memory_mb: template.memory_mb, cpu_limit: template.cpu_limit,
    health_check: true, health_check_mode: "http", health_check_path: template.health_check.path,
    health_check_expected_statuses: template.health_check.expected_statuses,
  };
}
