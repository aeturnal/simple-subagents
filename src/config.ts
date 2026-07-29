import { readFile } from "node:fs/promises";
import type { SimpleSubagentsConfig } from "./types.js";

export interface LoadConfigResult {
  config: SimpleSubagentsConfig;
  warning?: string;
}

export async function loadConfig(configPath: string): Promise<LoadConfigResult> {
  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return { config: { confirmWrites: false } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: { confirmWrites: true },
      warning: `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      config: { confirmWrites: true },
      warning: `Invalid config in ${configPath}: confirmWrites must be a boolean`,
    };
  }

  const confirmWrites = Reflect.get(parsed, "confirmWrites");
  if (confirmWrites === undefined) {
    return { config: { confirmWrites: false } };
  }

  if (typeof confirmWrites !== "boolean") {
    return {
      config: { confirmWrites: true },
      warning: `Invalid config in ${configPath}: confirmWrites must be a boolean`,
    };
  }

  return { config: { confirmWrites } };
}
