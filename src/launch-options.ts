import type { AgentProfile, JobRequest, LaunchThinkingSource, ThinkingLevel } from "./types.js";
import { isThinkingLevel, modelThinkingSuffix } from "./thinking.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export interface LaunchDefaults {
  parentModel?: string;
  thinkingLevel?: string;
}

export interface LaunchOptions {
  modelArgument?: string;
  thinkingArgument?: ThinkingLevel;
  launchModel?: string;
  launchThinkingLevel?: ThinkingLevel;
  launchThinkingSource: LaunchThinkingSource;
  diagnostics: string[];
}

export const resolveLaunchOptions = (
  request: JobRequest,
  profile: AgentProfile,
  defaults: LaunchDefaults,
): LaunchOptions => {
  const diagnostics: string[] = [];

  if (request.model !== undefined) {
    if (typeof request.model !== "string" || request.model.length === 0 || request.model.trim() !== request.model || CONTROL_CHARACTERS.test(request.model)) {
      diagnostics.push("Model must be a non-empty trimmed string without control characters");
    } else {
      const suffix = modelThinkingSuffix(request.model);
      if (suffix) {
        diagnostics.push(`Model must not encode thinking with the reserved suffix :${suffix}; use thinkingLevel instead`);
      }
    }
  }
  if (request.thinkingLevel !== undefined && !isThinkingLevel(request.thinkingLevel)) {
    diagnostics.push(`Unsupported thinking level: ${String(request.thinkingLevel)}`);
  }

  const modelArgument = request.model ?? profile.model ?? defaults.parentModel;
  let thinkingArgument: ThinkingLevel | undefined;
  let launchThinkingSource: LaunchThinkingSource = "model_or_pi_default";
  if (isThinkingLevel(request.thinkingLevel)) {
    thinkingArgument = request.thinkingLevel;
    launchThinkingSource = "job";
  } else if (profile.thinking !== undefined) {
    thinkingArgument = profile.thinking;
    launchThinkingSource = "profile";
  } else if (isThinkingLevel(defaults.thinkingLevel)) {
    thinkingArgument = defaults.thinkingLevel;
    launchThinkingSource = "parent";
  }

  return {
    modelArgument,
    thinkingArgument,
    launchModel: modelArgument,
    launchThinkingLevel: thinkingArgument,
    launchThinkingSource,
    diagnostics,
  };
};
