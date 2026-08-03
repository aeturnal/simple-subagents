import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && THINKING_LEVEL_SET.has(value);

export const modelThinkingSuffix = (model: string): ThinkingLevel | undefined => {
  const separator = model.lastIndexOf(":");
  if (separator < 0) return undefined;
  const suffix = model.slice(separator + 1);
  return isThinkingLevel(suffix) ? suffix : undefined;
};
