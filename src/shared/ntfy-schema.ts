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
  app_id: z.number().int().positive().nullable().default(null),
  alerts: z.boolean(),
  apps: z.boolean(),
  ios_push: z.boolean().default(false),
  cache_hours: z.number().int().min(1).max(168).default(24),
}).strict();
export type NtfySettings = z.infer<typeof NtfySettingsSchema>;
export const CreateNtfyAppSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,49}$/),
  domain: z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  server_id: z.number().int().positive(),
}).strict();
