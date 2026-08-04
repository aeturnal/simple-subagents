# Opt-In Subagent Thinking Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disable per-job subagent thinking overrides by default while allowing users to restore them with `allowThinkingOverrides: true` in the existing user configuration file.

**Architecture:** Parse the new setting with a fail-closed default. Build strict enabled and disabled variants of the `subagent_start` schema, and pass the selected policy into request conversion as a second protection. Load configuration during `session_start` before dynamically registering tools, which Pi supports without a reload.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, TypeBox, `node:test`, Pi 0.82.x extension API

## Global Constraints

- Store the setting only in `~/.pi/agent/simple-subagents.json` as `allowThinkingOverrides`.
- Missing, malformed, unreadable, or non-Boolean `allowThinkingOverrides` values must resolve to `false`.
- Disabled mode must omit and reject `thinkingLevel` at the tool schema and strip input injected after validation.
- Enabled mode must preserve existing job → profile → parent → Pi/model-default precedence.
- Disabled mode must produce profile → parent → Pi/model-default precedence by removing the job value before launch resolution.
- Keep `JobRequest.thinkingLevel`, `LaunchThinkingSource = "job"`, launch resolution, and source renderers because enabled mode still uses them.
- Keep per-job model overrides available in both modes.
- Do not add a command, UI setting, project setting, dependency, migration, or unrelated refactor.
- Configuration changes take effect after `/reload` or restart.
- The main working tree has unrelated uncommitted changes. At execution time, use the `using-git-worktrees` skill and create an isolated worktree from the commit containing this plan.

## File Map

- `src/types.ts`: add the normalized configuration property.
- `src/config.ts`: parse both configuration fields independently and apply safe fallback values.
- `src/tools.ts`: build policy-specific schemas and strip or preserve job thinking during request conversion.
- `src/index.ts`: load configuration before registering tools during `session_start`.
- `test/config-agents.test.ts`: test defaults, valid values, and independent field failures.
- `test/tools.test.ts`: test both schemas, defense-in-depth conversion, and dynamic registration.
- `test/dashboard.test.ts`: update its extension configuration fixture to the normalized shape.
- `README.md`: document the default policy, opt-in setting, precedence, and reload requirement.

---

### Task 1: Parse `allowThinkingOverrides` Safely

**Files:**

- Modify: `src/types.ts:3-5`
- Modify: `src/config.ts:4-55`
- Test: `test/config-agents.test.ts:8-67`

**Interfaces:**

- Produces: `SimpleSubagentsConfig = { confirmWrites: boolean; allowThinkingOverrides: boolean }`.
- Produces: unchanged `loadConfig(configPath): Promise<LoadConfigResult>` with a fully normalized config.

- [ ] **Step 1: Add failing configuration tests**

Update the missing-file expectation and add tests that cover both Boolean values and independent invalid fields:

```ts
test("missing config falls back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const result = await loadConfig(join(root, "simple-subagents.json"));

  assert.deepEqual(result.config, {
    confirmWrites: false,
    allowThinkingOverrides: false,
  });
  assert.equal(result.warning, undefined);
});

test("valid configuration preserves both policy values", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, JSON.stringify({
    confirmWrites: true,
    allowThinkingOverrides: true,
  }));

  const result = await loadConfig(configPath);

  assert.deepEqual(result.config, {
    confirmWrites: true,
    allowThinkingOverrides: true,
  });
  assert.equal(result.warning, undefined);
});

test("invalid fields fail independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const invalidConfirmPath = join(root, "invalid-confirm.json");
  const invalidThinkingPath = join(root, "invalid-thinking.json");
  await writeFile(invalidConfirmPath, JSON.stringify({
    confirmWrites: "no",
    allowThinkingOverrides: true,
  }));
  await writeFile(invalidThinkingPath, JSON.stringify({
    confirmWrites: false,
    allowThinkingOverrides: "yes",
  }));

  const invalidConfirm = await loadConfig(invalidConfirmPath);
  assert.deepEqual(invalidConfirm.config, {
    confirmWrites: true,
    allowThinkingOverrides: true,
  });
  assert.match(invalidConfirm.warning ?? "", /confirmWrites/);

  const invalidThinking = await loadConfig(invalidThinkingPath);
  assert.deepEqual(invalidThinking.config, {
    confirmWrites: false,
    allowThinkingOverrides: false,
  });
  assert.match(invalidThinking.warning ?? "", /allowThinkingOverrides/);
});
```

Update unreadable-file, invalid-JSON, and invalid-object expectations to include `allowThinkingOverrides: false`.

- [ ] **Step 2: Run the configuration tests to verify RED**

```bash
npx tsx --test test/config-agents.test.ts
```

Expected: FAIL because normalized config objects do not yet contain `allowThinkingOverrides`.

- [ ] **Step 3: Add the normalized configuration type**

In `src/types.ts`:

```ts
export interface SimpleSubagentsConfig {
  confirmWrites: boolean;
  allowThinkingOverrides: boolean;
}
```

- [ ] **Step 4: Implement independent field parsing**

In `src/config.ts`, use these safe constants:

```ts
const MISSING_CONFIG: SimpleSubagentsConfig = {
  confirmWrites: false,
  allowThinkingOverrides: false,
};

const FAILED_CONFIG: SimpleSubagentsConfig = {
  confirmWrites: true,
  allowThinkingOverrides: false,
};
```

After confirming parsed JSON is an object, normalize each field independently:

```ts
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
```

Use `MISSING_CONFIG` for `ENOENT`. Use `FAILED_CONFIG` for unreadable files, malformed JSON, arrays, `null`, and other non-object roots. Preserve the existing warning wording where possible, but mention that the root must be an object rather than naming only `confirmWrites`.

- [ ] **Step 5: Run focused tests and type checking**

```bash
npx tsx --test test/config-agents.test.ts
npm run typecheck
```

Expected: the focused tests PASS. Type checking may identify test fixtures that still return the old one-field config; update only those fixture object literals in `test/tools.test.ts` and `test/dashboard.test.ts` to add `allowThinkingOverrides: false`, then rerun until PASS.

- [ ] **Step 6: Commit normalized configuration**

```bash
git add src/types.ts src/config.ts test/config-agents.test.ts test/tools.test.ts test/dashboard.test.ts
git commit -m "feat: add thinking override policy config"
```

---

### Task 2: Build Policy-Aware Start Schemas and Request Conversion

**Files:**

- Modify: `src/tools.ts:10-26,42-43,92-99,118-141,331-390`
- Test: `test/tools.test.ts:156-242,1180-1240`

**Interfaces:**

- Consumes: `allowThinkingOverrides: boolean` from Task 1.
- Produces: `startParamsFor(allowThinkingOverrides: boolean)` returning a strict enabled or disabled TypeBox schema.
- Produces: `startJobs(input, services, ctx, allowThinkingOverrides = false)`.
- Produces: `registerSubagentTools(pi, services, allowThinkingOverrides = false)`.

- [ ] **Step 1: Add failing schema-policy tests**

Import `startParamsFor` from `src/tools.ts`, then add:

```ts
test("start schema hides thinking overrides unless explicitly enabled", () => {
  const disabled = startParamsFor(false);
  const enabled = startParamsFor(true);
  const overrideInput = {
    tasks: [{ task: "review", thinkingLevel: "high" }],
  };

  assert.equal(Check(disabled, overrideInput), false);
  assert.equal(Check(enabled, overrideInput), true);
  assert.equal(Check(disabled, { tasks: [{ task: "review" }] }), true);

  const disabledTask = disabled.properties.tasks.items as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  const enabledTask = enabled.properties.tasks.items as {
    additionalProperties: boolean;
    properties: Record<string, unknown>;
  };
  assert.equal(disabledTask.additionalProperties, false);
  assert.equal(enabledTask.additionalProperties, false);
  assert.equal("thinkingLevel" in disabledTask.properties, false);
  assert.equal("thinkingLevel" in enabledTask.properties, true);
});
```

- [ ] **Step 2: Add a failing defense-in-depth test**

Replace the current per-job override start test with one test covering both policies:

```ts
test("startJobs strips disabled overrides and preserves enabled overrides", async () => {
  const disabled = createServices();
  const injected = {
    tasks: [{
      task: "review disabled",
      agent: "reviewer",
      model: "ollama/llama3.1:8b",
      thinkingLevel: "low" as const,
    }],
  };

  const disabledResult = await startJobs(
    injected,
    disabled.services,
    {} as never,
  );
  assert.deepEqual(disabled.runner.started[0]?.options.request, {
    task: "review disabled",
    agent: "reviewer",
    writeAccess: false,
    cwd: undefined,
    model: "ollama/llama3.1:8b",
  });
  assert.equal(disabledResult.details.jobs[0]?.launchThinkingSource, "parent");
  assert.equal(disabledResult.details.jobs[0]?.launchThinkingLevel, "high");

  const enabled = createServices();
  const enabledResult = await startJobs(
    { tasks: [{ ...injected.tasks[0], task: "review enabled" }] },
    enabled.services,
    {} as never,
    true,
  );
  assert.equal(enabled.runner.started[0]?.options.request.thinkingLevel, "low");
  assert.equal(enabledResult.details.jobs[0]?.launchThinkingSource, "job");
  assert.equal(enabledResult.details.jobs[0]?.launchThinkingLevel, "low");
});
```

This simulates input injected after schema validation. Disabled conversion must remove it even though the direct function receives it.

- [ ] **Step 3: Run the tests to verify RED**

```bash
npx tsx --test test/tools.test.ts
```

Expected: FAIL because `startParamsFor` does not exist and `startJobs` still forwards job thinking by default.

- [ ] **Step 4: Create strict enabled and disabled schemas**

In `src/tools.ts`, define shared task fields once:

```ts
const StartTaskFields = {
  task: Type.String({ minLength: 1 }),
  agent: Type.Optional(Type.String({ default: "generic" })),
  writeAccess: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ minLength: 1, pattern: MODEL_PATTERN })),
};

const DisabledStartTask = Type.Object(StartTaskFields, {
  additionalProperties: false,
});
const EnabledStartTask = Type.Object({
  ...StartTaskFields,
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
}, {
  additionalProperties: false,
});

const DisabledStartParams = Type.Object({
  tasks: Type.Array(DisabledStartTask, { minItems: 1, maxItems: 8 }),
});
const EnabledStartParams = Type.Object({
  tasks: Type.Array(EnabledStartTask, { minItems: 1, maxItems: 8 }),
});

export const StartParams = DisabledStartParams;
export const startParamsFor = (allowThinkingOverrides: boolean) =>
  allowThinkingOverrides ? EnabledStartParams : DisabledStartParams;
export type StartInput = Static<typeof EnabledStartParams>;
```

`StartParams` remains the safe default for callers and tests that import it directly.

- [ ] **Step 5: Gate request conversion and direct start execution**

Change conversion to:

```ts
const toRequest = (
  task: StartInput["tasks"][number],
  allowThinkingOverrides: boolean,
): JobRequest => ({
  task: task.task,
  agent: task.agent ?? "generic",
  writeAccess: task.writeAccess ?? false,
  cwd: task.cwd,
  model: task.model,
  ...(allowThinkingOverrides && task.thinkingLevel !== undefined
    ? { thinkingLevel: task.thinkingLevel }
    : {}),
});
```

Change `startJobs` to accept `allowThinkingOverrides = false` and pass it to every `toRequest` call. Do not change `resolveLaunchOptions`; disabled requests reach it without job thinking, while enabled requests preserve current behavior.

- [ ] **Step 6: Register the selected schema and execution policy**

Change the registration signature:

```ts
export function registerSubagentTools(
  pi: ExtensionAPI,
  services: ToolServices,
  allowThinkingOverrides = false,
): void {
```

For `subagent_start`, use:

```ts
parameters: startParamsFor(allowThinkingOverrides),
execute: async (_id, input, _signal, _update, ctx) =>
  startJobs(input, services, ctx, allowThinkingOverrides),
```

All other subagent tools are unchanged.

- [ ] **Step 7: Update existing direct registration assertions**

The existing `registered tools expose strict schema boundaries and required guidance` test should call `registerSubagentTools(pi, services, false)`. Remove its old unconditional `thinkingLevel` enum assertion; the new policy test owns both schema variants.

Where renderer tests need the old job-override result, pass `true` to both `startJobs` and `registerSubagentTools`. Other direct calls should rely on the safe default.

- [ ] **Step 8: Run focused tests and type checking**

```bash
npx tsx --test test/tools.test.ts test/launch-options.test.ts test/job-manager.test.ts
npm run typecheck
```

Expected: all commands PASS. Existing launch-resolution tests must still prove every supported level and job-first precedence when a policy-approved request contains `thinkingLevel`.

- [ ] **Step 9: Check diagnostics and commit**

Run `lsp_diagnostics` on `src/tools.ts` and `test/tools.test.ts`, followed by `lens_diagnostics` with `mode=all`. Expected: no blocking errors in edited files.

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: gate job thinking behind start policy"
```

---

### Task 3: Register Tools After Configuration Loads

**Files:**

- Modify: `src/index.ts:18-66`
- Test: `test/tools.test.ts:1280-1555`
- Test: `test/dashboard.test.ts:1000-1030`

**Interfaces:**

- Consumes: normalized config from Task 1 and `registerSubagentTools(pi, services, allowThinkingOverrides)` from Task 2.
- Produces: no subagent tools before `session_start`; policy-selected tools immediately after configuration and profile loading.

- [ ] **Step 1: Add failing runtime registration tests**

Add a helper that creates the extension with a chosen policy, initializes it, and returns its registered start tool:

```ts
const runtimeStartTool = async (allowThinkingOverrides: boolean) => {
  const pi = new FakePi();
  createSimpleSubagentsExtension({
    loadConfig: async () => ({
      config: { confirmWrites: false, allowThinkingOverrides },
    }),
    discoverProfiles: async () => ({
      agents: [{ ...profile, name: "generic", source: "builtin" as const }],
      diagnostics: [],
    }),
  })(pi as never);

  assert.equal(pi.tools.has("subagent_start"), false);
  await pi.emit("session_start", {}, fakeContext({ hasUI: true }, pi));
  const start = pi.tools.get("subagent_start");
  assert.ok(start);
  return start;
};

test("runtime registers the disabled start schema after config loads", async () => {
  const start = await runtimeStartTool(false);
  assert.equal(Check(start.parameters, {
    tasks: [{ task: "review", thinkingLevel: "high" }],
  }), false);
});

test("runtime registers the enabled start schema after opt-in", async () => {
  const start = await runtimeStartTool(true);
  assert.equal(Check(start.parameters, {
    tasks: [{ task: "review", thinkingLevel: "high" }],
  }), true);
});
```

Use the existing `FakePi.emit(event, payload, ctx)` signature exactly as defined in the test file.

- [ ] **Step 2: Run runtime tests to verify RED**

```bash
npx tsx --test test/tools.test.ts
```

Expected: FAIL because tools are currently registered before `session_start` with one static schema.

- [ ] **Step 3: Move tool registration into `session_start`**

In `src/index.ts`, initialize config with both safe defaults:

```ts
let config = {
  confirmWrites: false,
  allowThinkingOverrides: false,
};
let toolsRegistered = false;
```

Remove the factory-time `registerSubagentTools(pi, services)` call. After assigning loaded config and profiles inside `session_start`, register once:

```ts
config = loadedConfig.config;
profiles = new Map(discovered.agents.map((profile) => [profile.name, profile]));
if (!toolsRegistered) {
  registerSubagentTools(pi, services, config.allowThinkingOverrides);
  toolsRegistered = true;
}
```

Keep dashboard/UI registration at factory time. Keep warning notifications after state assignment. Pi refreshes dynamically registered tools immediately, and `/reload` creates a fresh extension instance that can select the other schema.

- [ ] **Step 4: Update runtime fixture configs**

In `test/tools.test.ts` and `test/dashboard.test.ts`, update every `loadConfig` stub to return a normalized config. Use `allowThinkingOverrides: false` unless a test explicitly covers opt-in behavior.

Do not change context-level `thinkingLevel`; that is parent-session inheritance and remains valid.

- [ ] **Step 5: Verify tool availability and existing runtime behavior**

Run:

```bash
npx tsx --test test/tools.test.ts test/dashboard.test.ts test/integration.test.ts
npm run typecheck
```

Expected: all commands PASS. Existing runtime tests must continue to find subagent tools after emitting `session_start`, and dashboard initialization must remain unchanged.

- [ ] **Step 6: Check diagnostics and commit**

Run `lsp_diagnostics` on `src/index.ts`, `test/tools.test.ts`, and `test/dashboard.test.ts`, followed by `lens_diagnostics` with `mode=all`.

```bash
git add src/index.ts test/tools.test.ts test/dashboard.test.ts
git commit -m "feat: register subagent tools from user policy"
```

---

### Task 4: Document the Opt-In Policy and Verify the Package

**Files:**

- Modify: `README.md:30-105`

**Interfaces:**

- Consumes: final configuration and runtime behavior.
- Produces: user instructions for safe defaults, opt-in behavior, precedence, and reload.

- [ ] **Step 1: Update the status and per-job examples**

Keep the existing profile example. Rename `### Per-job model and thinking` to `### Per-job model and optional thinking`.

Explain that model overrides remain available by default. Show the default start input without `thinkingLevel`:

```json
{
  "task": "Review the authentication changes",
  "agent": "reviewer",
  "writeAccess": false,
  "model": "anthropic/claude-sonnet-4-5"
}
```

Then state:

```md
Per-job thinking overrides are disabled by default. Normal thinking precedence is profile `thinking`, then the parent session, then Pi or the model default. This keeps the parent agent from increasing child reasoning on each launch.
```

- [ ] **Step 2: Document the user opt-in**

Expand the existing `~/.pi/agent/simple-subagents.json` example to:

```json
{
  "confirmWrites": false,
  "allowThinkingOverrides": false
}
```

Document these exact rules:

```md
Set `allowThinkingOverrides` to `true` and run `/reload` when you intentionally want per-job control. The `subagent_start` task schema will then expose `thinkingLevel`, and precedence becomes job `thinkingLevel`, profile `thinking`, parent session, then Pi or the model default. Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
```

Keep model suffix rejection and separate `--thinking` transport documentation.

- [ ] **Step 3: Search for contradictory claims**

```bash
rg -n --glob '!docs/superpowers/**' \
  'Per-job model and thinking|Thinking precedence is job|thinkingLevel.*optional|allowThinkingOverrides' \
  README.md src test
```

Expected: every job-first claim is explicitly conditional on `allowThinkingOverrides: true`; config, source, and tests contain the new setting; no text claims overrides are always enabled.

- [ ] **Step 4: Run final verification with fresh output**

```bash
npm test
npm run typecheck
git diff --check
```

Expected: all tests PASS, TypeScript reports no errors, and `git diff --check` prints nothing.

Run `lsp_diagnostics` for `src` and `test`, then `lens_diagnostics` with `mode=all`. Expected: no blocking errors in edited files. Record unrelated pre-existing warnings without changing unrelated code.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain opt-in subagent thinking overrides"
```

- [ ] **Step 6: Inspect the isolated result**

```bash
git status --short
git log -4 --oneline
git diff 37c0f7b..HEAD --stat
git diff 37c0f7b..HEAD -- README.md src test
```

Expected: the isolated worktree is clean and the implementation changes only configuration, policy-aware schemas/conversion, startup registration, tests, and README documentation. The diff also includes the approved spec and this plan. Do not merge, rebase, or copy these commits onto the dirty main working tree without the user's explicit integration choice.
