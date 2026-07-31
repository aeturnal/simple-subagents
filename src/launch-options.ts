import type { AgentProfile, JobRequest, LaunchThinkingSource, ThinkingLevel } from "./types.js";
import { THINKING_LEVELS } from "./types.js";

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export interface LaunchDefaults {
  parentModel?: string;
  thinkingLevel?: string;
}

export interface LaunchOptions {
  path: "legacy" | "override";
  modelArgument?: string;
  thinkingArgument?: ThinkingLevel;
  launchModel?: string;
  launchThinkingLevel?: ThinkingLevel;
  launchThinkingSource: LaunchThinkingSource;
  diagnostics: string[];
}

const legacyModel = (profile: AgentProfile, defaults: LaunchDefaults): string | undefined => {
  const model = profile.model ?? defaults.parentModel;
  const suffix = model?.slice(model.lastIndexOf(":") + 1);
  if (!model || !defaults.thinkingLevel || (model.includes(":") && suffix && THINKING_LEVEL_SET.has(suffix))) return model;
  return `${model}:${defaults.thinkingLevel}`;
};

export const resolveLaunchOptions = (
  request: JobRequest,
  profile: AgentProfile,
  defaults: LaunchDefaults,
): LaunchOptions => {
  const hasModelOverride = request.model !== undefined;
  const hasThinkingOverride = request.thinkingLevel !== undefined;
  const path = hasModelOverride || hasThinkingOverride ? "override" : "legacy";
  const diagnostics: string[] = [];

  if (hasModelOverride && (typeof request.model !== "string" || request.model.length === 0 || request.model.trim() !== request.model || CONTROL_CHARACTERS.test(request.model))) {
    diagnostics.push("Model must be a non-empty trimmed string without control characters");
  }
  if (hasThinkingOverride && !THINKING_LEVEL_SET.has(request.thinkingLevel as string)) {
    diagnostics.push(`Unsupported thinking level: ${String(request.thinkingLevel)}`);
  }

  if (path === "legacy") {
    const modelArgument = legacyModel(profile, defaults);
    const selectedModel = profile.model ?? defaults.parentModel;
    const suffix = selectedModel?.slice(selectedModel.lastIndexOf(":") + 1);
    const inheritedThinking = selectedModel
      && defaults.thinkingLevel
      && THINKING_LEVEL_SET.has(defaults.thinkingLevel)
      && !(selectedModel.includes(":") && suffix && THINKING_LEVEL_SET.has(suffix))
      ? defaults.thinkingLevel as ThinkingLevel
      : undefined;
    return {
      path,
      modelArgument,
      thinkingArgument: undefined,
      launchModel: modelArgument,
      launchThinkingLevel: inheritedThinking,
      launchThinkingSource: "legacy",
      diagnostics,
    };
  }

  const modelArgument = request.model ?? profile.model ?? defaults.parentModel;
  let thinkingArgument: ThinkingLevel | undefined;
  let launchThinkingSource: LaunchThinkingSource = "model_or_pi_default";
  if (hasThinkingOverride && THINKING_LEVEL_SET.has(request.thinkingLevel as string)) {
    thinkingArgument = request.thinkingLevel;
    launchThinkingSource = "job";
  } else if (hasModelOverride && defaults.thinkingLevel && THINKING_LEVEL_SET.has(defaults.thinkingLevel)) {
    thinkingArgument = defaults.thinkingLevel as ThinkingLevel;
    launchThinkingSource = "parent";
  }

  return {
    path,
    modelArgument,
    thinkingArgument,
    launchModel: modelArgument,
    launchThinkingLevel: thinkingArgument,
    launchThinkingSource,
    diagnostics,
  };
};
