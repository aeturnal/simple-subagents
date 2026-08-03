# Profile Thinking Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit Pi-normalized `thinking` field to agent profiles, use it as the default between job and parent thinking, and reject thinking encoded in model suffixes.

**Architecture:** A focused shared validator owns Pi-level membership and reserved model-suffix detection. Profile discovery stores and safely reports configured thinking, while launch resolution selects `job → profile → parent → Pi default` and always passes thinking separately through `--thinking`. Existing status projections gain the `profile` source; integration, documentation, and installed profiles migrate away from suffix syntax.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, TypeBox, `node:test`, Pi 0.82.x CLI JSON print mode

## Global Constraints

- Accept exactly Pi's normalized values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Thinking precedence is exactly: per-job `thinkingLevel`, profile `thinking`, parent session thinking, then Pi/model default.
- Keep per-job thinking overrides; profile thinking is a default, not a lock.
- Reject profile and per-job models whose final colon segment is one of the seven reserved thinking levels.
- Continue accepting ordinary opaque colon tags such as `ollama/llama3.1:8b`.
- Never strip, rewrite, or silently ignore a reserved model suffix.
- Pass every selected thinking level separately as `--thinking <level>`; never append thinking to a model string.
- Keep provider mapping and clamping inside Pi; add no Anthropic, Google, or OpenAI capability table or token-budget field.
- Preserve mandatory child `--no-extensions`, process-close settlement, model selection, tool access, cancellation, capture, activity, concurrency, and write authorization.
- Keep the implementation dependency-free and compatible with Node.js 22.19+ and Pi 0.82.x.
- Do not activate migrated user profiles against installed v0.8.1; apply the four local profile edits only after a package containing this feature is installed, then reload Pi.

---

## File Structure

- Create `src/thinking.ts`: shared supported-level and reserved-suffix validation.
- Create `test/thinking.test.ts`: direct table coverage for shared validation.
- Modify `src/types.ts`: profile thinking and launch-source types.
- Modify `src/agents.ts`: parse and reject invalid profile thinking and model suffixes.
- Modify `test/config-agents.test.ts`: profile parsing and diagnostic behavior.
- Modify `src/profile-discovery.ts`: safe public thinking metadata and text formatting.
- Modify `test/profile-discovery.test.ts`: public shape, formatting, privacy, and size boundaries.
- Modify `src/launch-options.ts`: suffix rejection, precedence, separate launch arguments, and removal of legacy path state.
- Modify `test/launch-options.test.ts`: complete launch-resolution table.
- Modify `src/job-status.ts`, `src/tools.ts`, and `src/output.ts`: profile-source presentation.
- Modify status/output tests: source labels and removal of legacy fixtures.
- Modify `test/job-manager.test.ts`: atomic batch rejection and new launch-option shape.
- Modify `test/process-runner.test.ts`: new launch-option shape and separate model/thinking assertions.
- Modify `test/integration.test.ts`: replace suffix integration with explicit profile thinking.
- Modify `README.md`: profile field, precedence, suffix rejection, and provider mapping.
- Prepare a post-install migration for four user files under `~/.pi/agent/agents/`; do not apply it during branch execution because installed v0.8.1 does not yet consume profile `thinking`.

---

### Task 1: Parse and Discover Profile Thinking

**Files:**

- Create: `src/thinking.ts`
- Create: `test/thinking.test.ts`
- Modify: `src/types.ts:17-41`
- Modify: `src/agents.ts:18-65, 91-116`
- Test: `test/config-agents.test.ts:43-134`
- Modify: `src/profile-discovery.ts:1-82`
- Test: `test/profile-discovery.test.ts:1-155`

**Interfaces:**

- Produces: `isThinkingLevel(value: unknown): value is ThinkingLevel`.
- Produces: `modelThinkingSuffix(model: string): ThinkingLevel | undefined`.
- Produces: `AgentProfile.thinking?: ThinkingLevel`.
- Produces: `PublicAgentProfile.thinking: ThinkingLevel | null` and `PublicAgentProfile.inheritsParentThinking: boolean`.
- Later tasks consume these exact names; do not introduce a second supported-level list.

- [ ] **Step 1: Write failing shared-validator tests**

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
  for (const model of ["provider/model", "ollama/llama3.1:8b", "vendor/model:preview", "vendor/model:real:tag"])
    assert.equal(modelThinkingSuffix(model), undefined, model);
});
```

- [ ] **Step 2: Run the validator test and verify RED**

Run:

```bash
npx tsx --test test/thinking.test.ts
```

Expected: FAIL because `src/thinking.ts` does not exist.

- [ ] **Step 3: Implement the shared validator**

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

Run the focused test again. Expected: 2 tests PASS.

- [ ] **Step 4: Write failing profile-discovery tests**

In `test/config-agents.test.ts`:

1. Expand `discovers generic and user markdown profiles` so its profile frontmatter includes `model: openai-codex/gpt-5.6-sol` and `thinking: medium`, then assert:

```ts
assert.equal(result.agents[1]?.model, "openai-codex/gpt-5.6-sol");
assert.equal(result.agents[1]?.thinking, "medium");
```

1. Add a table test that creates one valid profile for every `THINKING_LEVELS` entry and asserts all seven values survive discovery.
2. Add a test with invalid profiles using `thinking: ultra`, `thinking: MEDIUM`, `thinking: 1`, and quoted `thinking: " medium "`, followed alphabetically by a valid profile. Assert only `generic` and the valid profile remain, each invalid file receives a diagnostic containing `thinking` and the allowed values, and later discovery continues.
3. Add a profile model `openai-codex/gpt-5.6-sol:high` followed by a valid `ollama/llama3.1:8b` profile. Assert the suffixed profile is excluded, its diagnostic includes `:high` and `thinking: high`, and the ordinary colon model is retained unchanged.

In `test/profile-discovery.test.ts`, add `thinking: "medium"` to `privateProfile` and assert:

```ts
assert.equal(actual.thinking, "medium");
assert.equal(actual.inheritsParentThinking, false);
```

For the parent-inheritance test assert:

```ts
assert.equal(actual.thinking, null);
assert.equal(actual.inheritsParentThinking, true);
```

Update formatted discovery expectations and the synthetic `nextContent` record with:

```ts
`  Configured thinking: ${profile.thinking ?? "none"}`,
`  Inherits parent thinking: ${profile.inheritsParentThinking ? "yes" : "no"}`,
```

Replace the brittle exact `38`/`62` record-count assertions with:

```ts
assert.ok(discovery.profiles.length > 0);
assert.equal(discovery.omittedProfiles, profiles.length - discovery.profiles.length);
assert.ok(discovery.omittedProfiles >= 10);
```

Keep the existing proof that the next whole record exceeds either the content or details byte limit.

- [ ] **Step 5: Run profile tests and verify RED**

Run:

```bash
npx tsx --test test/config-agents.test.ts test/profile-discovery.test.ts
```

Expected: FAIL because `AgentProfile` and public discovery do not expose thinking and invalid profile values are not rejected.

- [ ] **Step 6: Implement profile parsing and diagnostics**

In `src/types.ts`, add:

```ts
thinking?: ThinkingLevel;
```

to `AgentProfile` after `model`.

In `src/agents.ts`, import `isThinkingLevel` and `modelThinkingSuffix`. Add an internal validator:

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

Import `THINKING_LEVELS`, call this validator in `discoverAgents` after frontmatter parsing and before `createAgent`, and emit `Skipped ${filePath}: ${error}` before continuing. In `createAgent`, store:

```ts
thinking: isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
```

Do not change missing-name, project-profile, duplicate, or parse-error behavior.

- [ ] **Step 7: Implement safe public thinking metadata**

In `src/profile-discovery.ts`, import `ThinkingLevel`, add the two exact interface fields, map them in `toPublicAgentProfile`, and add these lines after model inheritance in `formatPublicProfile`:

```ts
`  Configured thinking: ${profile.thinking ?? "none"}`,
`  Inherits parent thinking: ${profile.inheritsParentThinking ? "yes" : "no"}`,
```

Use `thinking: profile.thinking ?? null` and `inheritsParentThinking: profile.thinking === undefined`. Do not expose raw frontmatter or profile paths.

- [ ] **Step 8: Run Task 1 verification**

Run:

```bash
npx tsx --test test/thinking.test.ts test/config-agents.test.ts test/profile-discovery.test.ts
npm run typecheck
```

Expected: all focused tests PASS and typecheck exits zero.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/thinking.ts src/types.ts src/agents.ts src/profile-discovery.ts \
  test/thinking.test.ts test/config-agents.test.ts test/profile-discovery.test.ts
git commit -m "feat: add profile thinking metadata"
```

---

### Task 2: Resolve and Report Profile Thinking

**Files:**

- Modify: `src/launch-options.ts`
- Test: `test/launch-options.test.ts`
- Modify: `src/types.ts:25-31`
- Modify: `src/job-status.ts:114-126`
- Modify: `src/tools.ts:266-298`
- Modify: `src/output.ts:38-48`
- Test: `test/job-manager.test.ts`
- Test: `test/job-status.test.ts`
- Test: `test/json-output.test.ts`
- Test: `test/tools.test.ts`
- Test: `test/dashboard.test.ts`
- Test: `test/live-widget.test.ts`
- Test: `test/process-runner.test.ts`

**Interfaces:**

- Consumes: Task 1 `isThinkingLevel`, `modelThinkingSuffix`, and `AgentProfile.thinking`.
- Produces: `LaunchOptions` without `path`.
- Produces: `LaunchThinkingSource = "job" | "profile" | "parent" | "model_or_pi_default"`.
- Produces: launch precedence `job → profile → parent → Pi/model default`.

- [ ] **Step 1: Replace launch-resolution tests with the new failing contract**

In `test/launch-options.test.ts`, update the profile helper to accept both model and thinking:

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

Replace legacy/path expectations with table cases asserting exact `LaunchOptions` objects without `path`:

- Job model and job thinking select source `job` over profile `medium` and parent `high`.
- Job model without job thinking selects profile `medium` over parent `high`.
- No job overrides selects profile `medium` over parent `high`.
- Missing profile thinking selects valid parent `high`.
- Missing job/profile/parent thinking selects `model_or_pi_default` with no thinking argument.
- Invalid parent `ultra` selects `model_or_pi_default` without a diagnostic.
- Every valid job thinking value remains accepted.

Add a suffix table over all `THINKING_LEVELS`; each `request.model = provider/model:<level>` must produce a diagnostic containing the suffix and `thinkingLevel`. Assert ordinary tags `ollama/llama3.1:8b`, `vendor/model:preview`, and `vendor/model:real:tag` remain unchanged with no diagnostic.

Keep existing blank, whitespace, and control-character model diagnostics and unsupported job-thinking diagnostics.

- [ ] **Step 2: Add a failing atomic batch-rejection test**

In `test/job-manager.test.ts`, add a test that enqueues two requests where the second model is `openai-codex/gpt-5.6-sol:high`. Assert `enqueue` throws a message containing `:high` and `thinkingLevel`, runner call count remains zero, `manager.list()` remains empty, and the next valid enqueue receives `job-1`.

- [ ] **Step 3: Run resolver and manager tests and verify RED**

Run:

```bash
npx tsx --test test/launch-options.test.ts test/job-manager.test.ts
```

Expected: FAIL because profile precedence, suffix rejection, atomic rejection, and the path-free launch shape are not implemented.

- [ ] **Step 4: Implement path-free launch resolution**

In `src/types.ts`, replace `LaunchThinkingSource` with:

```ts
export type LaunchThinkingSource =
  | "job"
  | "profile"
  | "parent"
  | "model_or_pi_default";
```

In `src/launch-options.ts`:

- Import `isThinkingLevel` and `modelThinkingSuffix` from `./thinking.js`.
- Remove the local thinking set, `legacyModel`, all suffix appending, and `LaunchOptions.path`.
- Preserve existing basic request-model validation.
- For a basically valid per-job model, append this diagnostic when reserved:

```ts
const suffix = modelThinkingSuffix(request.model);
diagnostics.push(
  `Model must not encode thinking with the reserved suffix :${suffix}; use thinkingLevel instead`,
);
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

Return model and thinking separately with no `path` property. Invalid request values still produce diagnostics and are rejected by `JobManager` before mutation.

- [ ] **Step 5: Run resolver and manager tests and verify GREEN**

Run the Step 3 command again. Expected: all focused tests PASS.

- [ ] **Step 6: Write failing profile-source presentation tests**

Add or update focused assertions so a job with `launchThinkingLevel: "medium"` and `launchThinkingSource: "profile"` renders:

```text
medium (profile)
```

Cover:

- `projectJobStatus` and `formatSingleJobStatus` in `test/job-status.test.ts`.
- Start/status/control rendering in `test/tools.test.ts`.
- `formatCollectedResult` in `test/json-output.test.ts`.
- Dashboard launch details in `test/dashboard.test.ts`.
- Live-widget fallback continues showing the selected level without requiring new source-detail text in `test/live-widget.test.ts`.

In expanded `subagent_agents` rendering, assert configured profiles show `Thinking: medium` and missing values show `Thinking: parent thinking (inherited)`.

Remove every `legacy` launch-source fixture and every `path: "legacy" | "override"` fixture across tests. Replace them with `profile`, `parent`, `job`, or `model_or_pi_default` according to the tested behavior. Update manual `LaunchOptions` fixtures in `test/process-runner.test.ts` to omit `path`.

In `test/process-runner.test.ts`, rename `passes legacy launch options with child extension isolation` to `passes inherited thinking separately with child extension isolation`. Its exact arguments must contain clean model `ollama/llama3.1:8b` followed by `--thinking`, `high`; they must not contain `ollama/llama3.1:8b:high`. In the opaque-model loop, replace reserved examples `anthropic/sonnet:high` and `vendor/model:real:high` with `anthropic/sonnet:preview` and `vendor/model:real:tag`; retain `ollama/llama3.1:8b`.

Update job-manager and tool fixtures that previously expected `parent-model:high` or `parent/model:high` so they expect the clean model plus `launchThinkingLevel: "high"` and `launchThinkingSource: "parent"`.

Run:

```bash
npx tsx --test test/job-status.test.ts test/json-output.test.ts test/tools.test.ts \
  test/dashboard.test.ts test/live-widget.test.ts test/process-runner.test.ts
```

Expected: FAIL until production formatters recognize `profile` and public tool rendering exposes profile thinking.

- [ ] **Step 7: Implement profile-source presentation**

Update the existing source-label branches in `src/job-status.ts`, `src/tools.ts`, and `src/output.ts`:

- `job` → `job override`
- `profile` → `profile`
- `parent` → `parent session`
- no selected level → `model or Pi default`

Remove all `legacy profile/parent behavior` branches.

In `renderAgentProfiles`, add after the model line:

```ts
`  Thinking: ${profile.thinking ?? "parent thinking (inherited)"}`,
```

Do not add source detail to compact live-widget rows.

- [ ] **Step 8: Run Task 2 verification**

Run:

```bash
npx tsx --test test/launch-options.test.ts test/job-manager.test.ts \
  test/job-status.test.ts test/json-output.test.ts test/tools.test.ts \
  test/dashboard.test.ts test/live-widget.test.ts test/process-runner.test.ts
npm run typecheck
rg -n 'path: "(?:legacy|override)"|launchThinkingSource: "legacy"|legacy profile/parent behavior' src test
```

Expected: all focused tests PASS, typecheck exits zero, and `rg` returns no matches.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/launch-options.ts src/types.ts src/job-status.ts src/tools.ts src/output.ts \
  test/launch-options.test.ts test/job-manager.test.ts test/job-status.test.ts \
  test/json-output.test.ts test/tools.test.ts test/dashboard.test.ts \
  test/live-widget.test.ts test/process-runner.test.ts
git commit -m "feat: resolve profile thinking explicitly"
```

---

### Task 3: Update Integration, Documentation, and Migration Handoff

**Files:**

- Test: `test/integration.test.ts:71-121`
- Modify: `README.md:48-86`
- Post-install activation target: `~/.pi/agent/agents/reviewer.md`
- Post-install activation target: `~/.pi/agent/agents/security-auditor.md`
- Post-install activation target: `~/.pi/agent/agents/test-automator.md`
- Post-install activation target: `~/.pi/agent/agents/typescript-pro.md`

**Interfaces:**

- Consumes: Task 1 profile frontmatter `thinking` and Task 2 path-free launch resolution.
- Produces: real-Pi coverage for profile thinking and an exact post-install local-profile migration handoff.
- No new runtime interface is introduced.

- [ ] **Step 1: Replace the obsolete integration test**

Replace `real Pi accepts explicit thinking over a model-pattern suffix` with `real Pi accepts explicit profile thinking`.

The replacement keeps the existing temporary-directory, runner, cancellation, and cleanup structure, but:

- Removes `SIMPLE_SUBAGENTS_INTEGRATION_MODEL_WITH_THINKING` and every suffixed model pattern.
- Uses a generic profile copy with `thinking: "low"`.
- Uses a request with no `thinkingLevel`.
- Resolves launch options from that profile and empty defaults.
- Asserts exactly one `--no-extensions` remains.
- Asserts `--thinking` receives `low` and no `--model` argument is present.
- Runs the prompt `Reply with exactly: profile-thinking-ok`.
- Asserts exit code zero and exact output `profile-thinking-ok`.

Run with integration disabled:

```bash
npx tsx --test test/integration.test.ts
```

Expected: both opt-in tests are discovered and skipped without failure.

- [ ] **Step 2: Update README profile and precedence documentation**

Update the profile example to include a clean model plus `thinking: medium`. Replace suffix-support text with:

- The seven exact Pi values.
- Precedence `job thinkingLevel → profile thinking → parent → Pi/model default`.
- Profile thinking is a default, not a lock.
- Thinking is passed separately through `--thinking`.
- Final suffixes equal to Pi thinking levels are rejected in profile and job models.
- `ollama/llama3.1:8b` remains valid.
- Pi performs Anthropic, Google, OpenAI, and other provider mapping and clamping.

Keep child extension isolation and parent-prepares-sources documentation unchanged.

- [ ] **Step 3: Prepare the four-profile post-install migration**

Inspect these approved user profiles without modifying them:

```text
/Users/aeturnal/.pi/agent/agents/reviewer.md
/Users/aeturnal/.pi/agent/agents/security-auditor.md
/Users/aeturnal/.pi/agent/agents/test-automator.md
/Users/aeturnal/.pi/agent/agents/typescript-pro.md
```

Verify each currently contains exactly `model: openai-codex/gpt-5.6-sol:medium` and no `thinking` field. Record in the task report that, immediately after a package containing this feature is installed, each file must replace only that model line with:

```yaml
model: openai-codex/gpt-5.6-sol
thinking: medium
```

Do not apply the edits during branch execution. Installed v0.8.1 ignores profile `thinking`; applying the migration early would make a fresh Pi session inherit parent thinking during the transition. The later activation must not alter prompts, tools, names, descriptions, licenses, or upstream metadata.

- [ ] **Step 4: Run focused and opt-in integration verification**

Run:

```bash
npx tsx --test test/integration.test.ts
SIMPLE_SUBAGENTS_INTEGRATION=1 \
  npx tsx --test \
  --test-name-pattern='real Pi accepts explicit profile thinking' \
  test/integration.test.ts
```

Expected: normal run skips the two opt-in tests; selected real-Pi test PASSes, launches with `--no-extensions`, passes `--thinking low`, and exits normally.

- [ ] **Step 5: Run complete project verification**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run
git diff --check
```

Expected:

- `npm test`: all non-opt-in tests PASS; only the two real-Pi tests are skipped.
- `npm run typecheck`: exits zero with no TypeScript errors.
- `npm pack --dry-run`: lists only intended package files and exits zero.
- `git diff --check`: exits zero.

Run primary LSP diagnostics for all changed TypeScript files before any build or release claim.

- [ ] **Step 6: Inspect scope and commit Task 3**

Run:

```bash
git status --short
git diff -- test/integration.test.ts README.md
```

Expected: repository changes for this task are limited to `test/integration.test.ts` and `README.md`. The four post-install profile edits are recorded in the task report but are not applied or staged.

Commit:

```bash
git add test/integration.test.ts README.md
git commit -m "docs: migrate explicit profile thinking"
```

- [ ] **Step 7: Verify the committed branch and migration**

Run:

```bash
git status --short --branch
git log --oneline -4
rg -n 'model: .*:(off|minimal|low|medium|high|xhigh|max)$' README.md src || true
```

Expected: the branch working tree is clean; three focused implementation commits follow the design/plan commits; README and production source contain no model example that encodes thinking in a suffix. Reserved suffix strings remain intentionally present in rejection tests. The four installed profiles remain on their v0.8.1-compatible suffix form until post-install activation.
