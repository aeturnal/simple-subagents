# Profile Thinking Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit Pi-normalized `thinking` field to agent profiles, use it as the default between job and parent thinking, and reject thinking encoded in model suffixes.

**Architecture:** A focused shared validator owns Pi-level membership and reserved model-suffix detection. Profile discovery stores and safely reports configured thinking. Launch resolution selects `job → profile → parent → Pi default` and always passes thinking separately through `--thinking`. Existing status projections gain the `profile` source. Integration, documentation, and installed profiles migrate away from suffix syntax.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, TypeBox, `node:test`, Pi 0.82.x CLI JSON print mode

## Global Constraints

- Accept exactly Pi's normalized values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Thinking precedence is exactly: per-job `thinkingLevel`, profile `thinking`, parent session thinking, then Pi/model default.
- Keep per-job thinking overrides; profile thinking is a default, not a lock.
- Reject profile and per-job models whose final colon segment is one of the seven reserved thinking levels.
- Continue accepting ordinary opaque colon tags such as `ollama/llama3.1:8b`.
- Never strip, rewrite, or silently ignore a reserved model suffix.
- Pass selected thinking separately as `--thinking <level>`; never append it to a model string.
- Keep provider mapping and clamping inside Pi. Add no provider capability table or token-budget field.
- Preserve mandatory child `--no-extensions`, process-close settlement, model selection, tool access, cancellation, capture, activity, concurrency, and write authorization.
- Keep the implementation dependency-free and compatible with Node.js 22.19+ and Pi 0.82.x.
- Do not activate migrated user profiles against installed v0.8.1. Apply the four local profile edits only after a package containing this feature is installed, then reload Pi.
- Restore recurring formatter-only rewrites before each focused commit.

## Task Boundaries

1. Shared thinking validation
2. Profile parsing and diagnostics
3. Public profile metadata and formatting
4. Launch resolution and atomic rejection
5. Status and collected-output presentation
6. Tool presentation and remaining fixture migration
7. Real-Pi integration, README, and migration handoff

---

### Task 1: Add Shared Thinking Validation

**Files:**

- Create: `src/thinking.ts`
- Create: `test/thinking.test.ts`

**Produces:**

- `isThinkingLevel(value: unknown): value is ThinkingLevel`
- `modelThinkingSuffix(model: string): ThinkingLevel | undefined`

Later tasks must use these exact helpers. Do not create another supported-level list.

- [ ] **Step 1: Write failing validator tests**

Create `test/thinking.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isThinkingLevel, modelThinkingSuffix } from "../src/thinking.ts";
import { THINKING_LEVELS } from "../src/types.ts";

test("accepts exactly Pi thinking levels", () => {
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  for (const value of [undefined, null, 1, "", " medium ", "MEDIUM", "ultra", "none"])
    assert.equal(isThinkingLevel(value), false, String(value));
});

test("detects only reserved final model suffixes", () => {
  for (const level of THINKING_LEVELS)
    assert.equal(modelThinkingSuffix(`provider/model:${level}`), level);
  for (const model of [
    "provider/model",
    "ollama/llama3.1:8b",
    "vendor/model:preview",
    "vendor/model:real:tag",
  ]) assert.equal(modelThinkingSuffix(model), undefined, model);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test test/thinking.test.ts
```

Expected: FAIL because `src/thinking.ts` does not exist.

- [ ] **Step 3: Implement the validator**

Create `src/thinking.ts`:

```ts
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
```

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test test/thinking.test.ts
npm run typecheck
git diff --check
git add src/thinking.ts test/thinking.test.ts
git commit -m "feat: validate thinking configuration"
```

Expected: 2 focused tests pass, typecheck exits zero, and the commit contains only the two listed files.

---

### Task 2: Parse Profile Thinking and Reject Invalid Profiles

**Files:**

- Modify: `src/types.ts`
- Modify: `src/agents.ts`
- Modify: `test/config-agents.test.ts`

**Consumes:** Task 1 validation helpers.

**Produces:** `AgentProfile.thinking?: ThinkingLevel` and profile-level diagnostics.

- [ ] **Step 1: Write failing profile tests**

In `test/config-agents.test.ts`:

1. Add `model: openai-codex/gpt-5.6-sol` and `thinking: medium` to the normal user-profile fixture. Assert both values survive discovery.
2. Add a table test creating one profile for every `THINKING_LEVELS` member. Assert all seven survive unchanged.
3. Add invalid profiles with `thinking: ultra`, `thinking: MEDIUM`, `thinking: 1`, and quoted `thinking: " medium "`, followed alphabetically by a valid profile. Assert only `generic` and the valid profile remain. Assert each invalid file gets a diagnostic containing `thinking` and the allowed values. Assert discovery continues after each error.
4. Add a profile model `openai-codex/gpt-5.6-sol:high`, followed by a valid `ollama/llama3.1:8b` profile. Assert the reserved-suffix profile is excluded, its diagnostic includes `:high` and `thinking: high`, and the ordinary colon model is retained unchanged.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test test/config-agents.test.ts
```

Expected: FAIL because profiles do not store or validate thinking.

- [ ] **Step 3: Add the profile field and validation**

In `src/types.ts`, add after `AgentProfile.model`:

```ts
thinking?: ThinkingLevel;
```

In `src/agents.ts`, import `THINKING_LEVELS`, `isThinkingLevel`, and `modelThinkingSuffix`. Add:

```ts
const profileThinkingError = (frontmatter: Record<string, unknown>): string | undefined => {
  if (frontmatter.thinking !== undefined && !isThinkingLevel(frontmatter.thinking))
    return `thinking must be one of ${THINKING_LEVELS.join(", ")}`;
  const model = asTrimmedString(frontmatter.model);
  const suffix = model ? modelThinkingSuffix(model) : undefined;
  return suffix
    ? `model must not encode thinking with the reserved suffix :${suffix}; use thinking: ${suffix}`
    : undefined;
};
```

Call it in `discoverAgents` after parsing frontmatter and before `createAgent`. On error, append `Skipped ${filePath}: ${error}` and continue. In `createAgent`, store:

```ts
thinking: isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
```

Do not change missing-name, duplicate, project-profile, or parse-error behavior.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test test/thinking.test.ts test/config-agents.test.ts
npm run typecheck
git diff --check
git add src/types.ts src/agents.ts test/config-agents.test.ts
git commit -m "feat: parse profile thinking"
```

Expected: focused tests pass and the commit contains only profile parsing, types, and tests.

---

### Task 3: Expose Safe Public Thinking Metadata

**Files:**

- Modify: `src/profile-discovery.ts`
- Modify: `test/profile-discovery.test.ts`

**Consumes:** `AgentProfile.thinking` from Task 2.

**Produces:**

- `PublicAgentProfile.thinking: ThinkingLevel | null`
- `PublicAgentProfile.inheritsParentThinking: boolean`

- [ ] **Step 1: Write failing public-profile tests**

Add `thinking: "medium"` to the private-profile fixture. Assert its public record has:

```ts
assert.equal(actual.thinking, "medium");
assert.equal(actual.inheritsParentThinking, false);
```

For a profile without thinking, assert:

```ts
assert.equal(actual.thinking, null);
assert.equal(actual.inheritsParentThinking, true);
```

Update formatted-profile expectations and the synthetic next-record calculation with:

```ts
`  Configured thinking: ${profile.thinking ?? "none"}`,
`  Inherits parent thinking: ${profile.inheritsParentThinking ? "yes" : "no"}`,
```

Replace brittle exact `38` and `62` count assertions with:

```ts
assert.ok(discovery.profiles.length > 0);
assert.equal(discovery.omittedProfiles, profiles.length - discovery.profiles.length);
assert.ok(discovery.omittedProfiles >= 10);
```

Keep the existing proof that adding the next whole record would exceed either the content or details byte limit.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test test/profile-discovery.test.ts
```

Expected: FAIL because public profiles do not expose thinking metadata.

- [ ] **Step 3: Implement public metadata and formatting**

In `src/profile-discovery.ts`, import `ThinkingLevel`. Add the two exact interface fields. Map them with:

```ts
thinking: profile.thinking ?? null,
inheritsParentThinking: profile.thinking === undefined,
```

Add the two configured/inherited lines after model inheritance in `formatPublicProfile`. Do not expose raw frontmatter, profile paths, or prompt bodies.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test test/profile-discovery.test.ts test/config-agents.test.ts
npm run typecheck
git diff --check
git add src/profile-discovery.ts test/profile-discovery.test.ts
git commit -m "feat: report profile thinking metadata"
```

Expected: focused tests pass and size-bound output still keeps only whole profile records.

---

### Task 4: Resolve Thinking and Reject Suffixed Job Models Atomically

**Files:**

- Modify: `src/types.ts`
- Modify: `src/launch-options.ts`
- Modify: `test/launch-options.test.ts`
- Modify: `test/job-manager.test.ts`

**Consumes:** Task 1 helpers and Task 2 profile field.

**Produces:**

- `LaunchOptions` without `path`
- `LaunchThinkingSource = "job" | "profile" | "parent" | "model_or_pi_default"`
- Precedence `job → profile → parent → Pi/model default`

- [ ] **Step 1: Write the failing launch-resolution table**

Update the test profile helper to accept model and thinking:

```ts
const profile = (model?: string, thinking?: ThinkingLevel): AgentProfile => ({
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  model,
  thinking,
  source: "user",
});
```

Replace legacy/path expectations with exact objects covering:

- Job model and job thinking over profile `medium` and parent `high`: source `job`.
- Job model without job thinking: profile `medium` wins, source `profile`.
- No job overrides: profile `medium` wins over parent `high`.
- Missing profile thinking: valid parent `high`, source `parent`.
- Missing job/profile/parent thinking: no thinking argument, source `model_or_pi_default`.
- Invalid parent `ultra`: no thinking argument and no diagnostic.
- Every valid per-job thinking value remains accepted.

Add a suffix table over all `THINKING_LEVELS`. Each `request.model = provider/model:<level>` must produce a diagnostic containing the suffix and `thinkingLevel`. Assert `ollama/llama3.1:8b`, `vendor/model:preview`, and `vendor/model:real:tag` remain opaque and valid. Keep blank, whitespace, control-character, and unsupported job-thinking tests.

- [ ] **Step 2: Add failing atomic batch coverage**

In `test/job-manager.test.ts`, enqueue a two-request batch whose second model is `openai-codex/gpt-5.6-sol:high`. Assert:

- `enqueue` rejects with `:high` and `thinkingLevel` in the message.
- Runner call count remains zero.
- `manager.list()` remains empty.
- The next valid enqueue receives `job-1`.

Update all existing job-manager launch fixtures to remove `path`. Where legacy behavior expected `parent-model:high`, expect clean `parent-model`, `launchThinkingLevel: "high"`, and source `parent`.

- [ ] **Step 3: Verify RED**

```bash
npx tsx --test test/launch-options.test.ts test/job-manager.test.ts
```

Expected: FAIL because profile precedence, suffix rejection, atomic rejection, and the path-free shape are not implemented.

- [ ] **Step 4: Implement launch resolution**

In `src/types.ts`, replace the launch source union with:

```ts
export type LaunchThinkingSource =
  | "job"
  | "profile"
  | "parent"
  | "model_or_pi_default";
```

In `src/launch-options.ts`:

- Import `isThinkingLevel` and `modelThinkingSuffix`.
- Remove the local thinking set, `legacyModel`, suffix construction, and `LaunchOptions.path`.
- Preserve existing basic request-model validation.
- For a basically valid per-job model with a reserved suffix, append:

```ts
`Model must not encode thinking with the reserved suffix :${suffix}; use thinkingLevel instead`
```

- Resolve model with `request.model ?? profile.model ?? defaults.parentModel`.
- Resolve thinking exactly:

```ts
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
```

Return model and thinking separately. Invalid request values remain diagnostics that `JobManager` rejects before mutation.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test test/launch-options.test.ts test/job-manager.test.ts
npm run typecheck
rg -n 'path: "(?:legacy|override)"|launchThinkingSource: "legacy"' \
  src/launch-options.ts test/launch-options.test.ts test/job-manager.test.ts
git diff --check
git add src/types.ts src/launch-options.ts test/launch-options.test.ts test/job-manager.test.ts
git commit -m "feat: resolve profile thinking explicitly"
```

Expected: tests pass, typecheck exits zero, and `rg` returns no matches.

---

### Task 5: Present Profile Thinking in Status and Collected Output

**Files:**

- Modify: `src/job-status.ts`
- Modify: `src/output.ts`
- Modify: `test/job-status.test.ts`
- Modify: `test/json-output.test.ts`

**Consumes:** Task 4 launch source union.

**Produces:** Stable user text `medium (profile)` in status and collected output.

- [ ] **Step 1: Write failing presentation tests**

Use a job with:

```ts
launchThinkingLevel: "medium",
launchThinkingSource: "profile",
```

Assert `projectJobStatus`, `formatSingleJobStatus`, and `formatCollectedResult` render `medium (profile)`. Preserve existing assertions for:

- `job` → `job override`
- `parent` → `parent session`
- no selected level → `model or Pi default`

Remove legacy launch-source fixtures from these two test files.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --test test/job-status.test.ts test/json-output.test.ts
```

Expected: FAIL because production formatting does not recognize `profile`.

- [ ] **Step 3: Implement source labels**

Update the existing branches in `src/job-status.ts` and `src/output.ts`:

- `job` → `job override`
- `profile` → `profile`
- `parent` → `parent session`
- no selected level → `model or Pi default`

Remove every `legacy profile/parent behavior` branch. Do not change progress truncation, activity text, timestamps, captures, or result shapes.

- [ ] **Step 4: Verify and commit**

```bash
npx tsx --test test/job-status.test.ts test/json-output.test.ts
npm run typecheck
rg -n 'launchThinkingSource: "legacy"|legacy profile/parent behavior' \
  src/job-status.ts src/output.ts test/job-status.test.ts test/json-output.test.ts
git diff --check
git add src/job-status.ts src/output.ts test/job-status.test.ts test/json-output.test.ts
git commit -m "feat: report profile thinking source"
```

Expected: focused tests pass and `rg` returns no matches.

---

### Task 6: Update Tool Presentation and Remaining Fixtures

**Files:**

- Modify: `src/tools.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/dashboard.test.ts`
- Modify: `test/live-widget.test.ts`
- Modify: `test/process-runner.test.ts`

**Consumes:** Tasks 3–5 public metadata and source labels.

**Produces:** Consistent `/subagents`, tool, dashboard, widget, and process-runner expectations.

- [ ] **Step 1: Write failing tool tests**

In `test/tools.test.ts`:

- Assert start/status/control rendering shows `medium (profile)` for a profile-selected job.
- In expanded `subagent_agents`, assert configured profiles show `Thinking: medium`.
- Assert profiles without thinking show `Thinking: parent thinking (inherited)`.
- Keep compact profile rendering concise; do not add metadata lines there.
- Remove all legacy launch-source and `path` fixtures.
- Update fixtures that expected `parent/model:high` to expect clean `parent/model`, level `high`, and source `parent`.

- [ ] **Step 2: Update remaining fixture contracts**

In `test/dashboard.test.ts`, use source `profile` and assert dashboard launch details show `medium (profile)`.

In `test/live-widget.test.ts`, replace legacy source fixtures. Keep the compact row showing only the selected level; do not add source-detail text.

In `test/process-runner.test.ts`:

- Remove `path` from every manual `LaunchOptions` fixture.
- Rename `passes legacy launch options with child extension isolation` to `passes inherited thinking separately with child extension isolation`.
- Assert arguments contain exactly one `--no-extensions`, clean model `ollama/llama3.1:8b`, and separate `--thinking`, `high`.
- Assert arguments do not contain `ollama/llama3.1:8b:high`.
- In the opaque-model table, use `anthropic/sonnet:preview`, `ollama/llama3.1:8b`, and `vendor/model:real:tag`. Do not retain reserved thinking suffixes as accepted runner examples.

- [ ] **Step 3: Verify RED**

```bash
npx tsx --test test/tools.test.ts test/dashboard.test.ts \
  test/live-widget.test.ts test/process-runner.test.ts
```

Expected: tool tests fail until production rendering recognizes profile thinking. Fixture-only tests may already pass after migration.

- [ ] **Step 4: Implement tool presentation**

In `src/tools.ts`, use the same source labels as Task 5. Remove the legacy branch. In expanded `renderAgentProfiles`, add after the model line:

```ts
`  Thinking: ${profile.thinking ?? "parent thinking (inherited)"}`,
```

Do not change compact rendering, authorization, schema, start-batch handling, dashboard wiring, or cancellation behavior.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test test/tools.test.ts test/dashboard.test.ts \
  test/live-widget.test.ts test/process-runner.test.ts
npm run typecheck
rg -n 'path: "(?:legacy|override)"|launchThinkingSource: "legacy"|legacy profile/parent behavior' src test
git diff --check
git add src/tools.ts test/tools.test.ts test/dashboard.test.ts \
  test/live-widget.test.ts test/process-runner.test.ts
git commit -m "feat: show profile thinking in tools"
```

Expected: focused tests pass, typecheck exits zero, and the repository-wide legacy `rg` returns no matches.

---

### Task 7: Update Integration, Documentation, and Migration Handoff

**Files:**

- Modify: `test/integration.test.ts`
- Modify: `README.md`
- Inspect only during branch work: `~/.pi/agent/agents/reviewer.md`
- Inspect only during branch work: `~/.pi/agent/agents/security-auditor.md`
- Inspect only during branch work: `~/.pi/agent/agents/test-automator.md`
- Inspect only during branch work: `~/.pi/agent/agents/typescript-pro.md`

**Consumes:** All preceding runtime behavior.

**Produces:** Real-Pi proof, user documentation, and an exact post-install migration handoff.

- [ ] **Step 1: Replace the obsolete integration test**

Replace `real Pi accepts explicit thinking over a model-pattern suffix` with `real Pi accepts explicit profile thinking`.

Keep its temporary directory, runner, cancellation, and cleanup structure, but:

- Remove `SIMPLE_SUBAGENTS_INTEGRATION_MODEL_WITH_THINKING` and suffixed model construction.
- Use a generic profile copy with `thinking: "low"`.
- Use a request without `thinkingLevel`.
- Resolve from that profile and empty parent defaults.
- Assert exactly one `--no-extensions`.
- Assert `--thinking` receives `low` and no `--model` argument is present.
- Prompt: `Reply with exactly: profile-thinking-ok`.
- Assert exit code zero and exact output `profile-thinking-ok`.

- [ ] **Step 2: Update README**

Update the profile example to use a clean model and `thinking: medium`. Document:

- The seven exact normalized values.
- Precedence `job thinkingLevel → profile thinking → parent → Pi/model default`.
- Profile thinking is a default, not a lock.
- Thinking is passed separately through `--thinking`.
- Final suffixes equal to normalized thinking levels are rejected in profile and job models.
- `ollama/llama3.1:8b` remains valid.
- Pi performs provider translation and clamping.

Keep child extension isolation and parent-prepares-sources text unchanged.

- [ ] **Step 3: Prepare the post-install profile migration**

Inspect without modifying:

```text
/Users/aeturnal/.pi/agent/agents/reviewer.md
/Users/aeturnal/.pi/agent/agents/security-auditor.md
/Users/aeturnal/.pi/agent/agents/test-automator.md
/Users/aeturnal/.pi/agent/agents/typescript-pro.md
```

Verify each currently has exactly:

```yaml
model: openai-codex/gpt-5.6-sol:medium
```

and no `thinking` field. Record this exact post-install replacement in the task report:

```yaml
model: openai-codex/gpt-5.6-sol
thinking: medium
```

Do not apply it during branch execution. Installed v0.8.1 ignores profile `thinking`, so early migration would make a fresh Pi session inherit parent thinking during the transition. After a compatible package is installed, change only these frontmatter lines and then reload Pi.

- [ ] **Step 4: Run integration verification**

```bash
npx tsx --test test/integration.test.ts
SIMPLE_SUBAGENTS_INTEGRATION=1 \
  npx tsx --test \
  --test-name-pattern='real Pi accepts explicit profile thinking' \
  test/integration.test.ts
```

Expected: the normal run discovers and skips both opt-in tests. The selected real-Pi test passes, launches with `--no-extensions`, passes `--thinking low`, and closes normally.

- [ ] **Step 5: Run full verification**

```bash
npm test
npm run typecheck
npm pack --dry-run
git diff --check
```

Expected:

- All non-opt-in tests pass.
- Exactly two real-Pi tests are skipped during the normal suite.
- Typecheck exits zero.
- Package dry-run contains only intended files.
- Diff check exits zero.

Run primary LSP diagnostics on all changed TypeScript files. Then run `lens_diagnostics` with `mode=all` and resolve every blocking diagnostic caused by this branch. The reported unused exports `StatusActivity`, `WaitOutcome`, and `ProcessStream` are informational pre-existing advisories unless a changed call site makes them newly relevant.

- [ ] **Step 6: Inspect scope and commit**

```bash
git status --short
git diff -- test/integration.test.ts README.md
```

Expected: this task changes only the integration test and README. The four post-install profile edits are recorded but not applied.

```bash
git add test/integration.test.ts README.md
git commit -m "docs: document explicit profile thinking"
```

- [ ] **Step 7: Verify the completed branch**

```bash
git status --short --branch
git log --oneline -8
rg -n 'model: .*:(off|minimal|low|medium|high|xhigh|max)$' README.md src || true
```

Expected: the branch is clean; seven focused implementation commits follow the design and plan commits; README and production source contain no model example with a thinking suffix. Reserved suffix strings remain intentionally present in rejection tests. Installed profiles remain in their v0.8.1-compatible suffix form until post-install activation.
