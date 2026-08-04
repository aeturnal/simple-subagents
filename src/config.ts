import { readFile } from "node:fs/promises";
import type { SimpleSubagentsConfig } from "./types.js";

export interface LoadConfigResult {
  config: SimpleSubagentsConfig;
  warning?: string;
}

const MISSING_CONFIG: SimpleSubagentsConfig = {
  confirmWrites: false,
  allowThinkingOverrides: false,
};

const FAILED_CONFIG: SimpleSubagentsConfig = {
  confirmWrites: true,
  allowThinkingOverrides: false,
};

export async function loadConfig(configPath: string): Promise<LoadConfigResult> {
  let raw: string;

  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: MISSING_CONFIG };
    }

    return {
      config: FAILED_CONFIG,
      warning: `Failed to read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: FAILED_CONFIG,
      warning: `Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      config: FAILED_CONFIG,
      warning: `Invalid config in ${configPath}: root must be an object`,
    };
  }

  const warnings: string[] = [];
  const rawConfirmWrites = Reflect.get(parsed, "confirmWrites");
  const rawAllowThinkingOverrides = Reflect.get(parsed, "allowThinkingOverrides");

  const confirmWrites = rawConfirmWrites === undefined
    ? false
    : typeof rawConfirmWrites === "boolean"
      ? rawConfirmWrites
      : (warnings.push("confirmWrites must be a boolean"), true);

  const allowThinkingOverrides = rawAllowThinkingOverrides === undefined
    ? false
    : typeof rawAllowThinkingOverrides === "boolean"
      ? rawAllowThinkingOverrides
      : (warnings.push("allowThinkingOverrides must be a boolean"), false);

  return {
    config: { confirmWrites, allowThinkingOverrides },
    ...(warnings.length > 0
      ? { warning: `Invalid config in ${configPath}: ${warnings.join("; ")}` }
      : {}),
  };
}
