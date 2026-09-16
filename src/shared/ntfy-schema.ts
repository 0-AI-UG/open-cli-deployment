import { z } from "zod";

export const NtfyBindingsSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.object({
  permissions: z.array(z.enum(["publish", "subscribe"])).min(1).default(["publish"]),
  generation: z.number().int().min(0).default(0),
}).strict());
export type NtfyBindings = z.infer<typeof NtfyBindingsSchema>;
export const NtfyPreferencesSchema = z.object({
  enabled: z.boolean(),
  events: z.array(z.enum(["app", "delivery", "disk", "backup"])),
  recovery: z.boolean(),
}).strict();
export type NtfyPreferences = z.infer<typeof NtfyPreferencesSchema>;
export const NtfySettingsSchema = z.object({
  enabled: z.boolean(),
  domain: z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  alerts: z.boolean(),
  apps: z.boolean(),
  ios_push: z.boolean().default(false),
  memory_mb: z.number().int().min(64).max(4096).default(128),
  cpu_limit: z.number().min(0.1).max(4).default(0.5),
  cache_hours: z.number().int().min(1).max(168).default(24),
}).strict();
export type NtfySettings = z.infer<typeof NtfySettingsSchema>;
