# Per-Job Model and Thinking Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each `subagent_start` task to override its child model and Pi thinking level without changing profiles, permissions, sibling jobs, or legacy launch arguments.

**Architecture:** Introduce one pure resolver that validates override values and prepares either the existing legacy model argument or a separate override-path `--model`/`--thinking` pair. `JobManager` resolves an entire batch before allocating IDs, snapshots launch metadata immediately, and gives the prepared options to the process runner; renderers distinguish those launch selections from the model later reported by Pi.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, TypeBox, Pi extension/AI/TUI APIs 0.82.x, Node's test runner through `tsx`.

## Global Constraints

- Start from the released Plans 01–03 state; preserve stale-safe notifications, `subagent_wait`, and `subagent_agents` unchanged.
- `thinkingLevel` supports exactly `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` through `StringEnum`.
- `model` is a non-empty, trimmed string without control characters; it remains an opaque Pi model ID or pattern and may contain any number of colons.
- Model precedence is job override, profile model, parent session model, then child Pi default.
- Job thinking precedence is job override; a new per-job model without a thinking override inherits parent session thinking when available; otherwise the model suffix or child Pi default decides.
- When neither new field is supplied, preserve existing profile suffix and parent-inheritance process arguments byte-for-byte.
- Never split, strip, append to, or otherwise rewrite a per-job model override.
- Overrides must not change `AgentProfile.systemPrompt`, tool allowlists, `writeAccess`, write confirmation, working directory, the parent session, or sibling jobs.
- Validate every request before mutating manager state; one invalid request creates no jobs and consumes no job IDs.
- Keep `job.model` unset at enqueue and let `JobManager.applyResult()` continue assigning it from `ProcessResult.model`.
- Pi, not this extension, resolves model patterns and validates model existence, provider authentication, and provider-specific constraints.
- Add no runtime dependency and no model-discovery, routing, budget, credential, or compatibility framework.
- Keep normal `npm test` credential-free; the real-Pi precedence check remains opt-in through `SIMPLE_SUBAGENTS_INTEGRATION=1`.

---

## File Structure

- `src/types.ts` — owns the supported thinking-level union and the request/job launch metadata contracts.
- `src/launch-options.ts` — new pure validation and precedence resolver; this is the only new production module.
- `src/job-manager.ts` — atomically prepares batches, snapshots launch metadata, and forwards prepared options.
- `src/process-runner.ts` — translates prepared options into exact Pi arguments while retaining the isolated legacy path.
- `src/tools.ts` — extends the public schema/request mapping and renders immediate start/status launch selections.
- `src/output.ts` — formats launch selections separately from the child-reported model in collected output.
- `src/dashboard.ts` — shows launch and reported selections in detailed dashboard inspection.
- `test/launch-options.test.ts` — new table-driven unit coverage for validation and precedence.
- `test/job-manager.test.ts`, `test/process-runner.test.ts`, `test/tools.test.ts`, `test/json-output.test.ts`, `test/dashboard.test.ts` — focused boundary and rendering regressions.
- `test/integration.test.ts` — opt-in real-Pi check for explicit `--thinking` with a suffixed model pattern.
- `README.md` — public precedence, validation, and launch-versus-reported documentation.

---

### Task 1: Define and test the pure launch-option resolver

**Files:**
- Create: `src/launch-options.ts`
- Create: `test/launch-options.test.ts`
- Modify: `src/types.ts:18-23,46-59`

**Interfaces:**
- Produces `THINKING_LEVELS`, `ThinkingLevel`, and `LaunchThinkingSource` from `src/types.ts`.
- Extends `JobRequest` with `model?: string` and `thinkingLevel?: ThinkingLevel`.
- Extends `Job` with `launchModel?`, `launchThinkingLevel?`, and `launchThinkingSource?` while preserving `model?` as reported-result data.
- Produces `resolveLaunchOptions(request, profile, defaults): LaunchOptions`; it never throws and returns validation text in `diagnostics`.
- `LaunchOptions.path` is `"legacy" | "override"`; `modelArgument` and `thinkingArgument` are the exact values later passed to Pi.

- [ ] **Step 1: Write the failing table-driven precedence and validation tests**

Create `test/launch-options.test.ts` with helpers and the complete precedence matrix:

```ts
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
```

- [ ] **Step 2: Run the resolver tests to verify RED**

Run:

```bash
npx tsx --test test/launch-options.test.ts
```

Expected: FAIL because `src/launch-options.ts`, `THINKING_LEVELS`, and the new request/job fields do not exist.

- [ ] **Step 3: Add the shared type contracts**

Add to `src/types.ts`:

```ts
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type LaunchThinkingSource = "job" | "parent" | "model_or_pi_default" | "legacy";

export interface JobRequest {
  task: string;
  agent: string;
  writeAccess: boolean;
  cwd?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}
```

Add these fields immediately before the existing `model?: string` in `Job` so the lifecycle distinction is visible in the type:

```ts
  launchModel?: string;
  launchThinkingLevel?: ThinkingLevel;
  launchThinkingSource?: LaunchThinkingSource;
  model?: string;
```

- [ ] **Step 4: Implement the minimal pure resolver**

Create `src/launch-options.ts`:

```ts
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
```

Do not parse a colon anywhere in the override branch.

- [ ] **Step 5: Run focused tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/launch-options.test.ts
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit the resolver boundary**

```bash
git add src/types.ts src/launch-options.ts test/launch-options.test.ts
git commit -m "feat: resolve per-job launch options"
```

---

### Task 2: Prepare launch options atomically in `JobManager`

**Files:**
- Modify: `src/job-manager.ts:1-80,205-217`
- Modify: `src/process-runner.ts:8-20`
- Modify: `test/job-manager.test.ts`

**Interfaces:**
- Consumes `resolveLaunchOptions(request, profile, defaults)` and `LaunchOptions` from Task 1.
- `InternalJob` stores one prepared `launchOptions` value alongside the existing defaults during the interface migration.
- Adds optional `ProcessRunOptions.launchOptions?: LaunchOptions` while retaining the existing required `parentModel`/`thinkingLevel` inputs for this green intermediate commit; Task 3 makes the prepared field required and removes those legacy inputs in one step.
- Enqueued `Job` snapshots expose `launchModel`, `launchThinkingLevel`, and `launchThinkingSource` immediately but leave `job.model` undefined.

- [ ] **Step 1: Write failing tests for immediate metadata, isolation, reported-model lifecycle, and atomic rejection**

Add these focused cases to `test/job-manager.test.ts`; the existing `StartedRun.options: ProcessRunOptions` declaration already exposes the optional migration field added in this task:

```ts
test("stores launch selections immediately without populating the reported model", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(
    [{ ...makeRequests(1)[0]!, model: "ollama/llama3.1:8b", thinkingLevel: "low" }],
    profiles,
    defaults,
  );

  assert.deepEqual({
    launchModel: job?.launchModel,
    launchThinkingLevel: job?.launchThinkingLevel,
    launchThinkingSource: job?.launchThinkingSource,
    reportedModel: job?.model,
  }, {
    launchModel: "ollama/llama3.1:8b",
    launchThinkingLevel: "low",
    launchThinkingSource: "job",
    reportedModel: undefined,
  });
  assert.equal(runner.started[0]?.options.profile.systemPrompt, profile.systemPrompt);
  assert.equal(runner.started[0]?.options.request.writeAccess, false);
});

test("rejects one invalid override before creating or starting any batch job", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const requests = [
    { ...makeRequests(1)[0]!, model: "openai/gpt-5" },
    { ...makeRequests(1)[0]!, task: "invalid", model: " bad" },
  ];

  assert.throws(() => manager.enqueue(requests, profiles, defaults), /non-empty trimmed string/i);
  assert.deepEqual(manager.list(), []);
  assert.equal(runner.started.length, 0);

  const [next] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.equal(next?.id, "job-1");
});

test("keeps launch model when Pi later reports a different resolved model", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue([{ ...makeRequests(1)[0]!, model: "anthropic/sonnet" }], profiles, defaults);
  assert.ok(job);

  runner.complete(0, { ...successfulResult("done"), model: "anthropic/claude-sonnet-4-5-20250929" });
  await runner.flush();

  assert.equal(manager.get(job.id)?.launchModel, "anthropic/sonnet");
  assert.equal(manager.get(job.id)?.model, "anthropic/claude-sonnet-4-5-20250929");
});

test("keeps override selections and failures isolated between sibling jobs", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 2 });
  const jobs = manager.enqueue([
    { ...makeRequests(1)[0]!, task: "unavailable", model: "missing/model", thinkingLevel: "low" },
    { ...makeRequests(1)[0]!, task: "available", model: "openai/gpt-5", thinkingLevel: "high" },
  ], profiles, defaults);

  assert.deepEqual(jobs.map((job) => [job.launchModel, job.launchThinkingLevel]), [
    ["missing/model", "low"],
    ["openai/gpt-5", "high"],
  ]);
  runner.complete(0, failedResult({ stderr: "model unavailable" }));
  runner.complete(1, successfulResult("sibling complete"));
  await runner.flush();

  assert.equal(manager.get(jobs[0]!.id)?.state, "failed");
  assert.equal(manager.get(jobs[1]!.id)?.state, "completed");
});
```

Also update the existing `"assigns stable increasing IDs and passes resolved process options"` assertion to expect one prepared options object rather than separate parent fields:

```ts
assert.deepEqual(runner.started[0]?.options.launchOptions, {
  path: "legacy",
  modelArgument: "parent-model:high",
  thinkingArgument: undefined,
  launchModel: "parent-model:high",
  launchThinkingLevel: "high",
  launchThinkingSource: "legacy",
  diagnostics: [],
});
```

- [ ] **Step 2: Run manager tests to verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="launch selections|invalid override|launch model|override selections|resolved process options" test/job-manager.test.ts
```

Expected: FAIL because enqueue does not resolve overrides or store launch metadata.

- [ ] **Step 3: Resolve the complete batch before allocating IDs**

Import the resolver and replace the current profile-only `selected` mapping with:

```ts
const selected = requests.map((request) => {
  const profile = profiles.get(request.agent);
  if (!profile) throw new Error(`Unknown agent profile: ${request.agent}`);
  const launchOptions = resolveLaunchOptions(request, profile, defaults);
  return { request, profile, launchOptions };
});
const diagnostic = selected.flatMap((entry) => entry.launchOptions.diagnostics)[0];
if (diagnostic) throw new Error(diagnostic);
```

This block must remain before `createdAt`, `nextId++`, `jobs.set`, `queue.push`, `notify`, and `pump`.

- [ ] **Step 4: Store prepared options and immediate job metadata**

Change `InternalJob` to retain the prepared data while leaving its existing defaults shape in place until Task 3 removes the old runner inputs:

```ts
interface InternalJob {
  job: Job;
  defaults: { cwd: string; parentModel?: string; thinkingLevel?: string };
  launchOptions: LaunchOptions;
  cancellationRequested: boolean;
  cancellation?: Promise<void>;
}
```

Change `enqueue()`'s defaults parameter to `LaunchDefaults & { cwd: string }`. Keep the existing manager/tool defaults shape `{ cwd: string; parentModel?: string; thinkingLevel?: string }`; `LaunchDefaults` intentionally accepts that shape while validating job-supplied thinking levels separately. Change the test fixture to `const defaults = { cwd: "/workspace", parentModel: "parent-model", thinkingLevel: "high" as const };`.

In the `selected.map` callback, add:

```ts
defaults: { ...defaults },
launchOptions: structuredClone(launchOptions),
job: {
  // existing fields stay unchanged
  launchModel: launchOptions.launchModel,
  launchThinkingLevel: launchOptions.launchThinkingLevel,
  launchThinkingSource: launchOptions.launchThinkingSource,
},
```

Do not assign `job.model` here. Add this migration field in `src/process-runner.ts`:

```ts
import type { LaunchOptions } from "./launch-options.js";

export interface ProcessRunOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  parentModel?: string;
  thinkingLevel?: string;
  launchOptions?: LaunchOptions;
  onProgress(item: ProgressItem): void;
}
```

In `pump()`, pass `launchOptions` in addition to the existing `parentModel` and `thinkingLevel` fields:

```ts
parentModel: entry.defaults.parentModel,
thinkingLevel: entry.defaults.thinkingLevel,
launchOptions: structuredClone(entry.launchOptions),
```

The runner deliberately ignores the optional migration field in this task; Task 3 switches it to the sole required launch-selection input. Leave `applyResult()` assigning `entry.job.model = result.model` unchanged.

- [ ] **Step 5: Run manager tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/job-manager.test.ts
npm run typecheck
```

Expected: both commands PASS. Runtime launch behavior is unchanged because the runner still uses the existing parent fields in this intermediate commit.

- [ ] **Step 6: Commit atomic enqueue preparation**

```bash
git add src/job-manager.ts src/process-runner.ts test/job-manager.test.ts
git commit -m "feat: prepare job launch metadata atomically"
```

---

### Task 3: Make the process runner consume prepared `--model` and `--thinking` arguments

**Files:**
- Modify: `src/process-runner.ts:8-20,98-103,145-152,167`
- Modify: `test/process-runner.test.ts`

**Interfaces:**
- Consumes `LaunchOptions` from `src/launch-options.ts` via `ProcessRunOptions.launchOptions`.
- Removes `ProcessRunOptions.parentModel` and `ProcessRunOptions.thinkingLevel`; the runner no longer resolves precedence.
- Emits `--model <modelArgument>` and `--thinking <thinkingArgument>` as separate argument pairs.
- Preserves the existing no-override argument sequence and initializes `ProcessResult.model` from the selected model as before, allowing a child `message_end` model to replace it.

- [ ] **Step 1: Update the test helper to supply legacy prepared options**

Import `resolveLaunchOptions` and replace repeated direct defaults with a helper:

```ts
import { resolveLaunchOptions } from "../src/launch-options.ts";

const runOptions = (overrides: Partial<ProcessRunOptions> = {}): ProcessRunOptions => {
  const nextRequest = overrides.request ?? request();
  const nextProfile = overrides.profile ?? profile({ systemPrompt: "" });
  return {
    cwd: overrides.cwd ?? "/workspace",
    request: nextRequest,
    profile: nextProfile,
    launchOptions: overrides.launchOptions ?? resolveLaunchOptions(nextRequest, nextProfile, {}),
    onProgress: overrides.onProgress ?? (() => {}),
  };
};
```

Wrap every existing `runner.run({ ... })` call in this file as `runner.run(runOptions({ ... }))`. Remove `parentModel` and `thinkingLevel` properties from those call objects; where an existing test needs parent inheritance, pass the exact `launchOptions: resolveLaunchOptions(nextRequest, nextProfile, { parentModel, thinkingLevel })` value shown in the legacy test below. Preserve each call's existing `cwd`, `request`, `profile`, and `onProgress` overrides.

- [ ] **Step 2: Write failing exact-argument tests for legacy and override paths**

Replace the current inherited-thinking tests with explicit prepared-option assertions:

```ts
test("keeps legacy process arguments byte-for-byte unchanged", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const legacyProfile = profile({ systemPrompt: "" });
  const legacyRequest = request();
  const running = runner.run(runOptions({
    request: legacyRequest,
    profile: legacyProfile,
    launchOptions: resolveLaunchOptions(legacyRequest, legacyProfile, { parentModel: "ollama/llama3.1:8b", thinkingLevel: "high" }),
  }));

  assert.deepEqual(invocation().args, [
    process.argv[1], "--mode", "json", "-p", "--no-session",
    "--model", "ollama/llama3.1:8b:high", "--no-tools", "Inspect the repository",
  ]);
  child.close();
  await running.result;
});

test("passes opaque override model and explicit thinking as separate arguments", async () => {
  for (const model of ["anthropic/sonnet:high", "ollama/llama3.1:8b", "vendor/model:real:high"]) {
    const { child, runner, invocation } = spawnedRunner();
    const nextRequest = request();
    const nextProfile = profile({ systemPrompt: "", tools: ["read", "bash"] });
    const running = runner.run(runOptions({
      request: nextRequest,
      profile: nextProfile,
      launchOptions: {
        path: "override",
        modelArgument: model,
        thinkingArgument: "low",
        launchModel: model,
        launchThinkingLevel: "low",
        launchThinkingSource: "job",
        diagnostics: [],
      },
    }));

    assert.equal(argumentValue(invocation().args, "--model"), model);
    assert.equal(argumentValue(invocation().args, "--thinking"), "low");
    assert.equal(argumentValue(invocation().args, "--tools"), "read");
    child.close();
    await running.result;
  }
});

test("passes thinking without model when child Pi must select its default", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run(runOptions({
    launchOptions: {
      path: "override",
      modelArgument: undefined,
      thinkingArgument: "max",
      launchModel: undefined,
      launchThinkingLevel: "max",
      launchThinkingSource: "job",
      diagnostics: [],
    },
  }));

  assert.equal(argumentValue(invocation().args, "--model"), undefined);
  assert.equal(argumentValue(invocation().args, "--thinking"), "max");
  child.close();
  await running.result;
});
```

The second test simultaneously proves colon opacity and that model/thinking changes do not widen the profile's read-only tool set.

- [ ] **Step 3: Run focused runner tests to verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="legacy process arguments|opaque override|thinking without model" test/process-runner.test.ts
```

Expected: FAIL because `ProcessRunOptions` does not accept prepared launch options and the runner never emits `--thinking`.

- [ ] **Step 4: Replace runner-side resolution with direct argument translation**

Replace the temporary interface from Task 2 and change the launch setup to:

```ts
export interface ProcessRunOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
  onProgress(item: ProgressItem): void;
}
```

Delete `THINKING_LEVELS` and `resolveModel`. At the start of `run()` use:

```ts
const { modelArgument, thinkingArgument } = options.launchOptions;
const args = ["--mode", "json", "-p", "--no-session"];
if (modelArgument) args.push("--model", modelArgument);
if (thinkingArgument) args.push("--thinking", thinkingArgument);
```

Initialize result metadata with:

```ts
let resultModel = modelArgument;
```

Do not branch on or parse `modelArgument`; `path` exists for inspectability and tests, not for runner-side resolution.

- [ ] **Step 5: Run all runner and manager tests to verify GREEN**

Run:

```bash
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts
npm run typecheck
```

Expected: both commands PASS, including the hard-coded legacy invocation.

- [ ] **Step 6: Commit the subprocess boundary**

```bash
git add src/process-runner.ts test/process-runner.test.ts src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: pass prepared model and thinking arguments"
```

---

### Task 4: Extend the start schema and immediate start/status rendering

**Files:**
- Modify: `src/tools.ts:1-14,58-63,151-172`
- Modify: `test/tools.test.ts`

**Interfaces:**
- Consumes `THINKING_LEVELS` and the new `JobRequest` fields.
- `StartParams.tasks[]` accepts optional `model` and `thinkingLevel`.
- Retains the existing `ToolServices.defaults()` `thinkingLevel?: string` contract.
- `toRequest()` preserves both values exactly.
- Expanded start and status rendering uses `Launch model:` and `Launch thinking:`; compact rendering remains unchanged.

- [ ] **Step 1: Write failing schema and request-forwarding tests**

Extend `"registered tools expose strict schema boundaries and required guidance"`:

```ts
const taskProperties = startSchema.properties.tasks.items.properties as {
  model: { minLength: number; pattern: string };
  thinkingLevel: { enum: string[] };
};
assert.equal(taskProperties.model.minLength, 1);
assert.deepEqual(taskProperties.thinkingLevel.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
assert.equal(new RegExp(taskProperties.model.pattern).test("ollama/llama3.1:8b"), true);
assert.equal(new RegExp(taskProperties.model.pattern).test(" leading"), false);
assert.equal(new RegExp(taskProperties.model.pattern).test("vendor/model\u0000name"), false);
```

Add a forwarding/rendering case:

```ts
test("startJobs forwards per-job overrides and renders launch selections immediately", async () => {
  const { services, runner } = createServices();
  const result = await startJobs({
    tasks: [{ task: "review", agent: "reviewer", model: "ollama/llama3.1:8b", thinkingLevel: "low" }],
  }, services, {} as never);

  assert.deepEqual(runner.started[0]?.options.request, {
    task: "review",
    agent: "reviewer",
    writeAccess: false,
    cwd: undefined,
    model: "ollama/llama3.1:8b",
    thinkingLevel: "low",
  });
  assert.equal(result.details.jobs[0]?.launchModel, "ollama/llama3.1:8b");

  const pi = new FakePi();
  registerSubagentTools(pi as never, services);
  const rendered = pi.tools.get("subagent_start")?.renderResult(
    result,
    { expanded: true },
    { fg: (_color: string, value: string) => value },
  ).render(160).join("\n") ?? "";
  assert.match(rendered, /Launch model: ollama\/llama3\.1:8b/);
  assert.match(rendered, /Launch thinking: low \(job override\)/);
});
```

In the existing generic-default test, update expected request objects to include `model: undefined` and `thinkingLevel: undefined`, proving old calls remain structurally compatible.

- [ ] **Step 2: Run focused tool tests to verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="strict schema|per-job overrides|generic read-only defaults" test/tools.test.ts
```

Expected: FAIL because the schema, mapper, and expanded renderer omit override fields.

- [ ] **Step 3: Add strict public schema fields and exact request mapping**

Import the shared levels and add:

```ts
import { THINKING_LEVELS } from "./types.js";

const MODEL_PATTERN = "^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f-\\u009f]+$";

const StartTask = Type.Object({
  task: Type.String({ minLength: 1 }),
  agent: Type.Optional(Type.String({ default: "generic" })),
  writeAccess: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ minLength: 1, pattern: MODEL_PATTERN })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
});
```

Keep the existing `ToolServices.defaults` type. Extend `toRequest()` without trimming or rewriting:

```ts
model: task.model,
thinkingLevel: task.thinkingLevel,
```

- [ ] **Step 4: Add one lightweight launch-selection formatter to expanded start/status output**

Add private helpers in `src/tools.ts`:

```ts
const launchThinking = (job: Job): string => {
  if (job.launchThinkingLevel) {
    const source = job.launchThinkingSource === "job" ? "job override"
      : job.launchThinkingSource === "parent" ? "parent session"
        : "legacy profile/parent behavior";
    return `${job.launchThinkingLevel} (${source})`;
  }
  return job.launchThinkingSource === "legacy" ? "legacy profile/parent behavior" : "model or Pi default";
};

const launchDetail = (job: Job): string => [
  `  ${job.request.task}`,
  `  Launch model: ${job.launchModel ?? "Pi default"}`,
  `  Launch thinking: ${launchThinking(job)}`,
].join("\n");
```

Replace the expanded start/status task-only mapping with `jobs.map(launchDetail).join("\n")`. Do not add these lines to `compact`.

- [ ] **Step 5: Run tool tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: both commands PASS, including the existing wait and profile-discovery tool tests.

- [ ] **Step 6: Commit the public tool contract**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: expose per-job launch overrides"
```

---

### Task 5: Distinguish launch and reported models in collected output

**Files:**
- Modify: `src/output.ts:53-62`
- Modify: `test/json-output.test.ts`

**Interfaces:**
- Consumes `Job.launchModel`, `launchThinkingLevel`, `launchThinkingSource`, and the existing reported `Job.model`.
- `formatCollectedResult(job)` labels launch metadata without claiming Pi resolved it.
- A differing child-reported model is retained alongside the launch model; failure diagnostics continue showing stderr and Pi errors.

- [ ] **Step 1: Write failing agreement, disagreement, and unavailable-model diagnostic tests**

Add to `test/json-output.test.ts`:

```ts
test("formats launch selection and matching child-reported model explicitly", () => {
  const formatted = formatCollectedResult(job({
    launchModel: "openai/gpt-5",
    launchThinkingLevel: "high",
    launchThinkingSource: "job",
    model: "openai/gpt-5",
  }));

  assert.match(formatted, /- Launch model: openai\/gpt-5/);
  assert.match(formatted, /- Launch thinking: high \(job override\)/);
  assert.match(formatted, /- Reported model: openai\/gpt-5/);
});

test("retains differing launch and reported models", () => {
  const formatted = formatCollectedResult(job({
    launchModel: "anthropic/sonnet",
    launchThinkingSource: "model_or_pi_default",
    model: "anthropic/claude-sonnet-4-5-20250929",
  }));

  assert.match(formatted, /- Launch model: anthropic\/sonnet/);
  assert.match(formatted, /- Reported model: anthropic\/claude-sonnet-4-5-20250929/);
});

test("keeps launch selection beside Pi unavailable-model diagnostics", () => {
  const formatted = formatCollectedResult(job({
    state: "failed",
    launchModel: "missing/provider-model",
    launchThinkingLevel: "low",
    launchThinkingSource: "job",
    stderr: "Model not found or provider authentication unavailable",
  }));

  assert.match(formatted, /- Launch model: missing\/provider-model/);
  assert.match(formatted, /Model not found or provider authentication unavailable/);
});
```

Update the old `"formats model, usage..."` assertion from `- Model:` to `- Reported model:`. Jobs without launch metadata must remain valid snapshots.

- [ ] **Step 2: Run formatter tests to verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="launch selection|differing launch|unavailable-model|model, usage" test/json-output.test.ts
```

Expected: FAIL because collected output only emits the ambiguous `Model:` label.

- [ ] **Step 3: Add explicit launch/reported metadata lines**

Add a small source-label helper and replace the model entry in `metadata`:

```ts
const thinkingSelection = (job: Job): string | undefined => {
  if (job.launchThinkingLevel) {
    const source = job.launchThinkingSource === "job" ? "job override"
      : job.launchThinkingSource === "parent" ? "parent session"
        : "legacy profile/parent behavior";
    return `${job.launchThinkingLevel} (${source})`;
  }
  if (job.launchThinkingSource === "model_or_pi_default") return "model or Pi default";
  if (job.launchThinkingSource === "legacy") return "legacy profile/parent behavior";
  return undefined;
};
```

Use these entries after `Task`:

```ts
...(job.launchModel ? [`- Launch model: ${job.launchModel}`] : []),
...(thinkingSelection(job) ? [`- Launch thinking: ${thinkingSelection(job)}`] : []),
...(job.model ? [`- Reported model: ${job.model}`] : []),
```

Do not overwrite, suppress, or compare away either model value.

- [ ] **Step 4: Run formatter and tool collection tests to verify GREEN**

Run:

```bash
npx tsx --test test/json-output.test.ts test/tools.test.ts
npm run typecheck
```

Expected: PASS after updating existing tool collection assertions from `Model:` to `Reported model:`.

- [ ] **Step 5: Commit collected-output terminology**

```bash
git add src/output.ts test/json-output.test.ts test/tools.test.ts
git commit -m "feat: distinguish launch and reported models"
```

---

### Task 6: Show launch selections in dashboard details

**Files:**
- Modify: `src/dashboard.ts:184-211`
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes the same `Job` launch fields as Task 5.
- Detailed dashboard inspection always shows `Launch model`, `Launch thinking`, and `Reported model` with honest absent/default text.
- Compact dashboard rows and the widget remain unchanged.

- [ ] **Step 1: Write failing dashboard detail tests**

Add a focused test:

```ts
test("dashboard details distinguish launch selections from the reported model", () => {
  const view = dashboard(new FakeManager([job("job-1", "completed", {
    launchModel: "anthropic/sonnet",
    launchThinkingLevel: "high",
    launchThinkingSource: "parent",
    model: "anthropic/claude-sonnet-4-5-20250929",
  })]));

  view.handleInput?.("\r");
  const detail = render(view, 160);
  assert.match(detail, /Launch model: anthropic\/sonnet/);
  assert.match(detail, /Launch thinking: high \(parent session\)/);
  assert.match(detail, /Reported model: anthropic\/claude-sonnet-4-5-20250929/);
  view.dispose();
});
```

Extend `"dashboard details always render every required label with absent-value placeholders"` with:

```ts
for (const label of ["Launch model:", "Launch thinking:", "Reported model:"]) {
  assert.ok(detail.includes(label), `missing ${label}`);
}
assert.match(detail, /Launch model: Pi default/);
assert.match(detail, /Reported model: not reported/);
```

- [ ] **Step 2: Run focused dashboard tests to verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="launch selections|absent-value placeholders" test/dashboard.test.ts
```

Expected: FAIL because dashboard details omit all three labels.

- [ ] **Step 3: Render honest launch and reported values**

Inside `detail()`, immediately after `Access`, add:

```ts
const thinkingSource = job.launchThinkingSource === "job" ? "job override"
  : job.launchThinkingSource === "parent" ? "parent session"
    : job.launchThinkingSource === "legacy" ? "legacy profile/parent behavior"
      : "model or Pi default";
wrap("Launch model: ", job.launchModel ?? "Pi default");
wrap("Launch thinking: ", job.launchThinkingLevel ? `${job.launchThinkingLevel} (${thinkingSource})` : thinkingSource);
wrap("Reported model: ", job.model ?? "not reported");
```

Do not add model text to `row()` or `formatWidgetLines()`.

- [ ] **Step 4: Run dashboard tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/dashboard.test.ts
npm run typecheck
```

Expected: both commands PASS and existing width-bound tests continue to pass.

- [ ] **Step 5: Commit dashboard launch details**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "feat: show launch options in dashboard details"
```

---

### Task 7: Add the opt-in real-Pi precedence check

**Files:**
- Modify: `test/integration.test.ts`

**Interfaces:**
- Consumes `resolveLaunchOptions()` and `PiProcessRunner` from earlier tasks.
- Uses `SIMPLE_SUBAGENTS_INTEGRATION_MODEL_WITH_THINKING` as a credentialed, available Pi model pattern that already contains a thinking suffix such as `anthropic/claude-sonnet-4-5:high`.
- Normal test runs remain skipped and credential-free.

- [ ] **Step 1: Add the opt-in integration test**

Append:

```ts
integrationTest("real Pi accepts explicit thinking over a model-pattern suffix", { timeout: 120_000 }, async (t) => {
  const modelPattern = process.env.SIMPLE_SUBAGENTS_INTEGRATION_MODEL_WITH_THINKING;
  if (!modelPattern) {
    t.skip("set SIMPLE_SUBAGENTS_INTEGRATION_MODEL_WITH_THINKING to an authenticated Pi model pattern ending in a thinking suffix");
    return;
  }

  const cwd = await mkdtemp(join(tmpdir(), "simple-subagents-thinking-integration-"));
  const profile = (await discoverAgents(join(cwd, "agents"))).agents.find((entry) => entry.name === "generic");
  assert.ok(profile);
  const request = {
    task: "Reply with exactly: precedence-ok",
    agent: "generic",
    writeAccess: false,
    thinkingLevel: "low" as const,
  };
  let invocation: { command: string; args: string[] } | undefined;
  const runner = new PiProcessRunner({
    fileExists: () => false,
    spawnProcess(command, args, options) {
      invocation = { command, args: [...args] };
      return spawn(command, args, options) as unknown as SpawnedProcess;
    },
  });
  const running = runner.run({
    cwd,
    request,
    profile,
    launchOptions: resolveLaunchOptions(request, { ...profile, model: modelPattern }, {}),
    onProgress() {},
  });
  t.after(async () => {
    await running.cancel();
    await running.result;
    await rm(cwd, { recursive: true, force: true });
  });

  assert.ok(invocation);
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], modelPattern);
  assert.equal(invocation.args[invocation.args.indexOf("--thinking") + 1], "low");
  const result = await running.result;
  assert.equal(result.exitCode, 0, `Pi stderr: ${result.stderr}`);
  assert.equal(result.output.trim(), "precedence-ok");
});
```

Import `resolveLaunchOptions`. Update the existing integration runner call to include `launchOptions: resolveLaunchOptions(request, generic, {})`, assigning its request object to a local constant first.

- [ ] **Step 2: Verify the normal suite skips real-Pi work**

Run:

```bash
npx tsx --test test/integration.test.ts
```

Expected: PASS with both integration tests reported as skipped.

- [ ] **Step 3: Run the credentialed check when configuration is available**

Run:

```bash
SIMPLE_SUBAGENTS_INTEGRATION=1 \
SIMPLE_SUBAGENTS_INTEGRATION_MODEL_WITH_THINKING='anthropic/claude-sonnet-4-5:high' \
npx tsx --test --test-name-pattern="explicit thinking" test/integration.test.ts
```

Expected: PASS with exact output `precedence-ok`. If that example model is not authenticated locally, replace only the environment value with an authenticated Pi model pattern that has a thinking suffix; do not change the test or mark a credential failure as a product failure.

- [ ] **Step 4: Commit the opt-in integration coverage**

```bash
git add test/integration.test.ts
git commit -m "test: verify explicit Pi thinking precedence"
```

---

### Task 8: Document per-job overrides and run release verification

**Files:**
- Modify: `README.md:28-50`

**Interfaces:**
- Documents the exact `subagent_start.tasks[]` fields and supported values.
- Explains launch versus reported terminology and delegates model resolution/authentication to Pi.
- Changes no runtime API.

- [ ] **Step 1: Add focused public documentation**

After the profile example in `README.md`, add:

````md
### Per-job model and thinking

A start task can temporarily override its child model and thinking level without changing the profile or parent session:

```json
{
  "task": "Review the authentication changes",
  "agent": "reviewer",
  "writeAccess": false,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high"
}
```

Both fields are optional. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Model selection is job override, then profile, then parent session, then Pi's child default. A job model without a job thinking level inherits the parent thinking level when available.

Model values are opaque Pi IDs or patterns. Values such as `ollama/llama3.1:8b` and models with multiple colons are passed unchanged through `--model`; job thinking is passed separately through `--thinking`, so it overrides a thinking shorthand in the model pattern according to Pi's CLI precedence. Pi remains responsible for pattern resolution, model availability, provider credentials, and provider-specific validation.

Start and status views report **Launch model** and **Launch thinking**, which describe the arguments selected by this extension. Collected output reports Pi's **Reported model** separately; both model values are shown when resolution produces a different model ID. Overrides do not change the profile prompt, tools, access mode, working directory, parent model, or sibling jobs.
````

Keep the existing access and lifecycle sections intact.

- [ ] **Step 2: Verify documentation contains every public contract term**

Run:

```bash
grep -nE "thinkingLevel|off.*minimal.*low.*medium.*high.*xhigh.*max|opaque|--model|--thinking|Launch model|Reported model|credentials" README.md
```

Expected: matches for the field, all seven levels, opaque model handling, separate arguments, launch/reported terminology, and credential delegation.

- [ ] **Step 3: Run the complete automated verification suite**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all tests PASS (real-Pi tests skipped without the opt-in environment), typecheck PASS, and `git diff --check` produces no output.

- [ ] **Step 4: Review the exact legacy subprocess regression one final time**

Run:

```bash
npx tsx --test --test-name-pattern="legacy process arguments" test/process-runner.test.ts
```

Expected: PASS against the complete hard-coded pre-feature argument array.

- [ ] **Step 5: Commit documentation and final consistency updates**

```bash
git add README.md
git commit -m "docs: explain per-job model overrides"
```
