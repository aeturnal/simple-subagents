import assert from "node:assert/strict";
import test from "node:test";
import { resolveLaunchOptions } from "../src/launch-options.ts";
import { THINKING_LEVELS, type AgentProfile, type JobRequest } from "../src/types.ts";

const profile = (model?: string): AgentProfile => ({
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  model,
  source: "user",
});
const request = (overrides: Partial<JobRequest> = {}): JobRequest => ({
  task: "Review authentication",
  agent: "reviewer",
  writeAccess: false,
  ...overrides,
});

test("resolves override model and thinking precedence without rewriting opaque IDs", () => {
  const cases = [
    {
      name: "job model and job thinking win",
      request: request({ model: "anthropic/claude-sonnet-4-5", thinkingLevel: "low" }),
      profile: profile("profile/model:high"),
      defaults: { parentModel: "parent/model", thinkingLevel: "high" as const },
      expected: { path: "override", modelArgument: "anthropic/claude-sonnet-4-5", thinkingArgument: "low", launchModel: "anthropic/claude-sonnet-4-5", launchThinkingLevel: "low", launchThinkingSource: "job", diagnostics: [] },
    },
    {
      name: "job model inherits parent thinking",
      request: request({ model: "ollama/llama3.1:8b" }),
      profile: profile("profile/model:high"),
      defaults: { parentModel: "parent/model", thinkingLevel: "high" as const },
      expected: { path: "override", modelArgument: "ollama/llama3.1:8b", thinkingArgument: "high", launchModel: "ollama/llama3.1:8b", launchThinkingLevel: "high", launchThinkingSource: "parent", diagnostics: [] },
    },
    {
      name: "thinking-only override keeps profile shorthand opaque",
      request: request({ thinkingLevel: "low" }),
      profile: profile("anthropic/claude-sonnet-4-5:high"),
      defaults: { parentModel: "parent/model", thinkingLevel: "medium" as const },
      expected: { path: "override", modelArgument: "anthropic/claude-sonnet-4-5:high", thinkingArgument: "low", launchModel: "anthropic/claude-sonnet-4-5:high", launchThinkingLevel: "low", launchThinkingSource: "job", diagnostics: [] },
    },
    {
      name: "thinking-only override allows child default model",
      request: request({ thinkingLevel: "max" }),
      profile: profile(),
      defaults: {},
      expected: { path: "override", modelArgument: undefined, thinkingArgument: "max", launchModel: undefined, launchThinkingLevel: "max", launchThinkingSource: "job", diagnostics: [] },
    },
    {
      name: "job model without parent thinking defers to model or Pi",
      request: request({ model: "vendor/real-model:high" }),
      profile: profile(),
      defaults: {},
      expected: { path: "override", modelArgument: "vendor/real-model:high", thinkingArgument: undefined, launchModel: "vendor/real-model:high", launchThinkingLevel: undefined, launchThinkingSource: "model_or_pi_default", diagnostics: [] },
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(resolveLaunchOptions(entry.request, entry.profile, entry.defaults), entry.expected, entry.name);
  }
});

test("accepts every supported job thinking level", () => {
  for (const thinkingLevel of THINKING_LEVELS) {
    assert.deepEqual(
      resolveLaunchOptions(request({ thinkingLevel }), profile(), {}),
      { path: "override", modelArgument: undefined, thinkingArgument: thinkingLevel, launchModel: undefined, launchThinkingLevel: thinkingLevel, launchThinkingSource: "job", diagnostics: [] },
    );
  }
});

test("keeps the existing legacy suffix behavior isolated", () => {
  assert.deepEqual(
    resolveLaunchOptions(request(), profile(), { parentModel: "ollama/llama3.1:8b", thinkingLevel: "high" }),
    { path: "legacy", modelArgument: "ollama/llama3.1:8b:high", thinkingArgument: undefined, launchModel: "ollama/llama3.1:8b:high", launchThinkingLevel: "high", launchThinkingSource: "legacy", diagnostics: [] },
  );
  assert.deepEqual(
    resolveLaunchOptions(request(), profile("anthropic/sonnet:low"), { parentModel: "parent/model", thinkingLevel: "high" }),
    { path: "legacy", modelArgument: "anthropic/sonnet:low", thinkingArgument: undefined, launchModel: "anthropic/sonnet:low", launchThinkingLevel: undefined, launchThinkingSource: "legacy", diagnostics: [] },
  );
});

test("reports invalid model and thinking values without normalizing them", () => {
  for (const model of ["", "   ", " leading", "trailing ", "vendor/model\u0000name", "vendor/model\u007fname"]) {
    const result = resolveLaunchOptions(request({ model }), profile(), {});
    assert.deepEqual(result.diagnostics, ["Model must be a non-empty trimmed string without control characters"]);
  }
  const invalid = resolveLaunchOptions(request({ thinkingLevel: "ultra" as never }), profile(), {});
  assert.deepEqual(invalid.diagnostics, ["Unsupported thinking level: ultra"]);
});
