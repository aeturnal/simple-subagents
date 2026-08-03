import assert from "node:assert/strict";
import test from "node:test";
import { resolveLaunchOptions } from "../src/launch-options.ts";
import { THINKING_LEVELS, type AgentProfile, type JobRequest, type ThinkingLevel } from "../src/types.ts";

const profile = (model?: string, thinking?: ThinkingLevel): AgentProfile => ({
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  model,
  thinking,
  source: "user",
});
const request = (overrides: Partial<JobRequest> = {}): JobRequest => ({
  task: "Review authentication",
  agent: "reviewer",
  writeAccess: false,
  ...overrides,
});

test("resolves thinking with job, profile, parent, then model or Pi default precedence", () => {
  const cases = [
    {
      name: "job model and job thinking win",
      request: request({ model: "anthropic/claude-sonnet-4-5", thinkingLevel: "low" }),
      profile: profile("profile/model", "medium"),
      defaults: { parentModel: "parent/model", thinkingLevel: "high" },
      expected: { modelArgument: "anthropic/claude-sonnet-4-5", thinkingArgument: "low", launchModel: "anthropic/claude-sonnet-4-5", launchThinkingLevel: "low", launchThinkingSource: "job", diagnostics: [] },
    },
    {
      name: "profile thinking wins when a job model has no thinking",
      request: request({ model: "ollama/llama3.1:8b" }),
      profile: profile("profile/model", "medium"),
      defaults: { parentModel: "parent/model", thinkingLevel: "high" },
      expected: { modelArgument: "ollama/llama3.1:8b", thinkingArgument: "medium", launchModel: "ollama/llama3.1:8b", launchThinkingLevel: "medium", launchThinkingSource: "profile", diagnostics: [] },
    },
    {
      name: "profile thinking wins without job overrides",
      request: request(),
      profile: profile("profile/model", "medium"),
      defaults: { parentModel: "parent/model", thinkingLevel: "high" },
      expected: { modelArgument: "profile/model", thinkingArgument: "medium", launchModel: "profile/model", launchThinkingLevel: "medium", launchThinkingSource: "profile", diagnostics: [] },
    },
    {
      name: "valid parent thinking is used when profile thinking is missing",
      request: request(),
      profile: profile(),
      defaults: { parentModel: "parent/model", thinkingLevel: "high" },
      expected: { modelArgument: "parent/model", thinkingArgument: "high", launchModel: "parent/model", launchThinkingLevel: "high", launchThinkingSource: "parent", diagnostics: [] },
    },
    {
      name: "missing thinking defers to model or Pi default",
      request: request(),
      profile: profile(),
      defaults: { parentModel: "parent/model" },
      expected: { modelArgument: "parent/model", thinkingArgument: undefined, launchModel: "parent/model", launchThinkingLevel: undefined, launchThinkingSource: "model_or_pi_default", diagnostics: [] },
    },
    {
      name: "invalid parent thinking defers without a diagnostic",
      request: request(),
      profile: profile(),
      defaults: { parentModel: "parent/model", thinkingLevel: "ultra" },
      expected: { modelArgument: "parent/model", thinkingArgument: undefined, launchModel: "parent/model", launchThinkingLevel: undefined, launchThinkingSource: "model_or_pi_default", diagnostics: [] },
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
      { modelArgument: undefined, thinkingArgument: thinkingLevel, launchModel: undefined, launchThinkingLevel: thinkingLevel, launchThinkingSource: "job", diagnostics: [] },
    );
  }
});

test("rejects reserved thinking suffixes in per-job model IDs while keeping opaque model IDs valid", () => {
  for (const thinkingLevel of THINKING_LEVELS) {
    const result = resolveLaunchOptions(request({ model: `provider/model:${thinkingLevel}` }), profile(), {});
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0] ?? "", new RegExp(`:${thinkingLevel}`));
    assert.match(result.diagnostics[0] ?? "", /thinkingLevel/);
  }

  for (const model of ["ollama/llama3.1:8b", "vendor/model:preview", "vendor/model:real:tag"]) {
    assert.deepEqual(resolveLaunchOptions(request({ model }), profile(), {}).diagnostics, [], model);
  }
});

test("reports invalid model and thinking values without normalizing them", () => {
  for (const model of ["", "   ", " leading", "trailing ", "vendor/model\u0000name", "vendor/model\u007fname"]) {
    const result = resolveLaunchOptions(request({ model }), profile(), {});
    assert.deepEqual(result.diagnostics, ["Model must be a non-empty trimmed string without control characters"]);
  }
  const invalid = resolveLaunchOptions(request({ thinkingLevel: "ultra" as never }), profile(), {});
  assert.deepEqual(invalid.diagnostics, ["Unsupported thinking level: ultra"]);
});
