export interface PluginContext {
  name: string;
  config: Record<string, unknown>;
  storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
}

export interface PluginDefinition {
  name: string;
  version?: string;
  minRole?: "blocked" | "limited" | "trusted" | "owner";
  configSchema?: unknown;
  tools?: (context: PluginContext) => Record<string, unknown>;
  hooks?: Record<string, (...arguments_: never[]) => unknown>;
  commands?: unknown[];
  agents?: unknown[];
  onLoad?: (context: PluginContext) => Promise<void> | void;
  onUnload?: () => Promise<void> | void;
}

export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.name))
    throw new Error("plugin name must be kebab-case");
  return plugin;
}

export { z } from "zod";
export { tool } from "ai";
export type { Role } from "@luoli/shared";
