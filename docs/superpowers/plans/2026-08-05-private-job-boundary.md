# Private Job Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent complete subagent jobs and malformed protocol text from entering persisted tool-result details while preserving current tool and dashboard behavior.

**Architecture:** Keep complete `Job` records inside `JobManager`. Project jobs to one small renderer-only shape at the `src/tools.ts` response boundary, and count malformed JSON records without retaining their text. Modify existing modules only; do not add a privacy framework or capture module.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, `node:test`, TypeBox, Pi extension APIs

## Global Constraints

- Keep the patch limited to suggestion-box items 1 and 2.
- Add no new source modules or dependencies.
- Do not redesign parsing, capture limits, collection budgets, lifecycle handling, or the dashboard.
- Explicit collection must still place the selected answer in tool-result content.
- Existing session files are not rewritten.
- Use test-driven development: observe each new regression test fail before changing production code.

---

## File map

- `src/tools.ts`: define and apply the bounded public job-detail projection; update render helpers to consume it.
- `src/json-stream.ts`: count malformed records and discard their raw text.
- `src/process-runner.ts`: stop returning malformed samples.
- `src/job-manager.ts`: stop copying malformed samples into jobs.
- `src/types.ts`: remove malformed sample storage from `Job`.
- `src/output.ts`: report malformed counts without sample text.
- `src/dashboard.ts`: fingerprint and display malformed counts without sample text.
- `test/tools.test.ts`: verify every tool operation returns safe, bounded job details.
- `test/json-output.test.ts`: verify malformed reasoning text is discarded and collection shows counts only.
- `test/process-runner.test.ts`: verify process results cannot contain malformed samples.
- `test/job-manager.test.ts`: retain malformed counts without sample propagation.
- `test/job-status.test.ts`: remove the obsolete malformed-sample fixture.
- `test/dashboard.test.ts`: verify the full dashboard shows only malformed counts.
- `README.md`: state the verified persistence boundary.

---

### Task 1: Project safe job details at the tool boundary

**Files:**

- Modify: `src/tools.ts:5-167,243-330`
- Test: `test/tools.test.ts:1-548`

**Interfaces:**

- Produces: `PublicJobDetail` with `id`, `state`, `task`, optional `launchModel`, optional `launchThinkingLevel`, and optional `launchThinkingSource`.
- Produces: `toPublicJobDetail(job: Readonly<Job>): PublicJobDetail` inside `src/tools.ts`.
- Changes: `ToolDetails.jobs` from `Job[]` to `PublicJobDetail[]`.
- Preserves: `ToolResponse`, `WaitToolDetails`, tool content, and existing renderer wording.

- [ ] **Step 1: Add a failing serialized-details regression helper and assertions**

In `test/tools.test.ts`, import `PublicJobDetail` from `src/tools.ts` and add this helper near `text()`:

```ts
const PUBLIC_JOB_DETAIL_KEYS = new Set<keyof PublicJobDetail>([
  "id",
  "state",
  "task",
  "launchModel",
  "launchThinkingLevel",
  "launchThinkingSource",
]);

const assertPublicJobDetails = (details: ToolDetails): void => {
  for (const job of details.jobs) {
    assert.ok(Object.keys(job).every((key) => PUBLIC_JOB_DETAIL_KEYS.has(key as keyof PublicJobDetail)));
  }
  assert.doesNotMatch(
    JSON.stringify(details.jobs),
    /PRIVATE_PROFILE_PROMPT|PRIVATE_OUTPUT|PRIVATE_STDERR|PRIVATE_ERROR|PRIVATE_PROGRESS|PRIVATE_MALFORMED/u,
  );
};
```

Change the shared test profile prompt to `"PRIVATE_PROFILE_PROMPT"`. Extend `completed()` so tests can add private result fields:

```ts
const completed = (output = "finished output", overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  output,
  stderr: "",
  usage: usage(),
  model: "test-model",
  malformedEventCount: 0,
  ...overrides,
});
```

In the single-status test, settle the job with:

```ts
completed("PRIVATE_OUTPUT", {
  stderr: "PRIVATE_STDERR",
  errorMessage: "PRIVATE_ERROR",
  malformedEventSamples: ["PRIVATE_MALFORMED"],
})
```

In the grouped-status fixture, use `"PRIVATE_PROFILE_PROMPT"`, `"PRIVATE_OUTPUT"`, `"PRIVATE_STDERR"`, `"PRIVATE_ERROR"`, `"PRIVATE_MALFORMED"`, and a diagnostic progress item containing `"PRIVATE_PROGRESS"` in their matching private fields.

Call `assertPublicJobDetails(result.details)` in the existing successful tests for start, single status, grouped status, cancellation, collection, and discard.

For collection, add explicit assertions proving the intended split:

```ts
assert.match(text(result), /PRIVATE_OUTPUT/u);
assert.doesNotMatch(JSON.stringify(result.details.jobs), /PRIVATE_OUTPUT/u);
```

In the grouped status test, require its detail list to use the same 20-job bound as the public status list:

```ts
assert.equal(details.jobs.length, 20);
```

Add a separate `"startJobs bounds public detail previews"` test. Start one task with `task: "t".repeat(2_000)` and `model: "m".repeat(2_000)`, then check every projected text field:

```ts
for (const job of result.details.jobs) {
  assert.ok(Buffer.byteLength(job.id, "utf8") <= 512);
  assert.ok(Buffer.byteLength(job.task, "utf8") <= 512);
  if (job.launchModel) assert.ok(Buffer.byteLength(job.launchModel, "utf8") <= 512);
}
```

- [ ] **Step 2: Run the tool tests and confirm the privacy assertions fail**

Run:

```bash
npx tsx --test test/tools.test.ts
```

Expected: FAIL first because `PublicJobDetail` is not exported. Without the production projection, the new allowlist assertions would also reject complete `Job` fields and grouped status would return more than 20 details.

- [ ] **Step 3: Add the minimal public projection in `src/tools.ts`**

Import `boundedPreview` and the three public field types:

```ts
import {
  boundedPreview,
  formatJobStatusList,
  formatSingleJobStatus,
  projectJobStatus,
  selectStatusList,
  type JobStatus,
} from "./job-status.js";
import {
  THINKING_LEVELS,
  type AgentProfile,
  type Job,
  type JobRequest,
  type JobState,
  type LaunchThinkingSource,
  type ThinkingLevel,
} from "./types.js";
```

Define the public shape beside `ToolDetails`:

```ts
export interface PublicJobDetail {
  id: string;
  state: JobState;
  task: string;
  launchModel?: string;
  launchThinkingLevel?: ThinkingLevel;
  launchThinkingSource?: LaunchThinkingSource;
}

const toPublicJobDetail = (job: Readonly<Job>): PublicJobDetail => ({
  id: boundedPreview(job.id),
  state: job.state,
  task: boundedPreview(job.request.task),
  ...(job.launchModel ? { launchModel: boundedPreview(job.launchModel) } : {}),
  ...(job.launchThinkingLevel ? { launchThinkingLevel: job.launchThinkingLevel } : {}),
  ...(job.launchThinkingSource ? { launchThinkingSource: job.launchThinkingSource } : {}),
});
```

Change `ToolDetails.jobs` and the shared response helper:

```ts
export interface ToolDetails {
  jobs: PublicJobDetail[];
  diagnostics: string[];
  operation?: "agents" | "start" | "status" | "wait" | "cancel" | "collect" | "discard";
  profiles?: PublicAgentProfile[];
  omittedProfiles?: number;
  statuses?: JobStatus[];
  omittedStatuses?: number;
}

const response = (
  content: string,
  jobs: readonly Job[] = [],
  diagnostics: string[] = [],
  operation?: ToolDetails["operation"],
): ToolResponse & { details: ToolDetails } => ({
  content: [{ type: "text", text: content }],
  details: { jobs: jobs.map(toPublicJobDetail), diagnostics, operation },
});
```

Use the projection in the two direct status responses. Keep grouped status details aligned with the already selected 20 statuses:

```ts
const detailJobsForStatuses = (jobs: readonly Job[], statuses: readonly JobStatus[]): PublicJobDetail[] => {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  return statuses.flatMap((status) => {
    const job = jobsById.get(status.id);
    return job ? [toPublicJobDetail(job)] : [];
  });
};
```

```ts
// Single status
details: {
  jobs: [toPublicJobDetail(job)],
  statuses: [status],
  diagnostics: [],
  operation: "status",
},

// Grouped status
details: {
  jobs: detailJobsForStatuses(jobs, selected.statuses),
  statuses: selected.statuses,
  omittedStatuses: selected.omitted,
  diagnostics: [],
  operation: "status",
},
```

Change only the renderer helper parameter types; keep their bodies and displayed text unchanged:

```ts
const iconForState = (state: JobState): string => {
  if (state === "completed") return "✓";
  if (state === "failed" || state === "cancelled") return "✗";
  if (state === "collected") return "↳";
  if (state === "discarded") return "⌫";
  return state === "queued" ? "○" : "…";
};

const launchThinking = (job: PublicJobDetail): string => {
  if (job.launchThinkingLevel) {
    const source = job.launchThinkingSource === "job" ? "job override"
      : job.launchThinkingSource === "parent" ? "parent session"
        : "legacy profile/parent behavior";
    return `${job.launchThinkingLevel} (${source})`;
  }
  return job.launchThinkingSource === "legacy" ? "legacy profile/parent behavior" : "model or Pi default";
};

const launchDetail = (job: PublicJobDetail): string => [
  `  ${job.task}`,
  `  Launch model: ${job.launchModel ?? "Pi default"}`,
  `  Launch thinking: ${launchThinking(job)}`,
].join("\n");
```

Do not change `summary()`: it formats live manager jobs before the response boundary and can continue accepting `readonly Job[]`.

- [ ] **Step 4: Run tool tests and typecheck**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: both commands PASS. Existing compact and expanded renderer assertions remain unchanged.

- [ ] **Step 5: Commit the public response boundary**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "fix: project safe subagent tool details"
```

---

### Task 2: Discard malformed protocol text at the parser

**Files:**

- Modify: `src/json-stream.ts:1-58`
- Modify: `src/process-runner.ts:20-33,285-306`
- Modify: `src/job-manager.ts:1-5,431-453`
- Modify: `src/types.ts:54-79`
- Modify: `src/output.ts:1-7,65-107`
- Modify: `src/dashboard.ts:26-52,236-277`
- Modify: `README.md:15-36,94-98`
- Test: `test/json-output.test.ts`
- Test: `test/process-runner.test.ts`
- Test: `test/job-manager.test.ts`
- Test: `test/job-status.test.ts`
- Test: `test/dashboard.test.ts`

**Interfaces:**

- Preserves: `JsonLineParser.malformedCount`, `ProcessResult.malformedEventCount`, and `Job.malformedEventCount`.
- Removes: `JsonLineParser.malformedSamples`, `ProcessResult.malformedEventSamples`, `Job.malformedEventSamples`, and `MALFORMED_EVENT_SAMPLE_MAX_BYTES`.
- Preserves: process state decisions, output capture, collection limits, and dashboard access to normal output/stderr/errors.

- [ ] **Step 1: Add the failing malformed-reasoning privacy test**

In `test/json-output.test.ts`, replace the malformed-sample retention tests with this regression test:

```ts
test("counts malformed reasoning records without retaining their text", () => {
  const parser = new JsonLineParser();
  const secret = "PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE";

  assert.deepEqual(
    parser.push(Buffer.from(`{"type":"reasoning","reasoning":"${secret}"\n`)),
    [],
  );
  assert.equal(parser.malformedCount, 1);
  assert.equal("malformedSamples" in parser, false);
  assert.doesNotMatch(JSON.stringify(parser), new RegExp(secret, "u"));
});
```

Update the oversized unterminated-record test to assert only count, reset, and recovery:

```ts
assert.equal(parser.malformedCount, 1);
assert.equal((parser as unknown as { pending: string }).pending, "");
assert.deepEqual(parser.push(Buffer.from('{"recovered":true}\n')), [{ recovered: true }]);
```

Replace the failed collection sample fixture with a legacy-shaped object. This proves the formatter does not expose raw text even if an old object still carries the removed property:

```ts
const legacyJob = job({
  state: "failed",
  malformedEventCount: 2,
}) as Job & { malformedEventSamples: string[] };
legacyJob.malformedEventSamples = ["PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE"];
const formatted = formatCollectedResult(legacyJob);

assert.match(formatted, /Malformed events: 2/u);
assert.doesNotMatch(formatted, /Malformed samples|PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE/u);
```

- [ ] **Step 2: Add failing runner, manager, and dashboard boundary assertions**

In `test/process-runner.test.ts`, rename the existing capture-bound test to `"bounds captured output, stderr, and assistant errors without returning malformed text"`. Keep the malformed stdout input, but replace sample assertions with:

```ts
assert.equal(result.malformedEventCount, 1);
assert.equal("malformedEventSamples" in result, false);
assert.doesNotMatch(JSON.stringify(result), /not-json-/u);
```

In `test/job-manager.test.ts`, remove `malformedEventSamples` from the failed result and expected job. Add:

```ts
const stored = manager.get(job.id);
assert.equal(stored?.malformedEventCount, 2);
assert.equal(stored && "malformedEventSamples" in stored, false);
```

In `test/dashboard.test.ts`, remove malformed sample fields from normal fixtures. For the full-view privacy assertion, pass one deliberate legacy-shaped job so the test fails while the dashboard still reads the old property:

```ts
const legacyJob = job("job-1", "failed", {
  malformedEventCount: 1,
}) as Job & { malformedEventSamples: string[] };
legacyJob.malformedEventSamples = ["PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE"];
const view = dashboard(new FakeManager([legacyJob]), pi);
```

After rendering the full view, assert:

```ts
assert.match(text, /Malformed: 1 malformed protocol/u);
assert.match(text, /event\./u);
assert.doesNotMatch(text, /malformed protocol samples|PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE/ui);
```

Remove the obsolete `malformedEventSamples` fixture from `test/job-status.test.ts`.

- [ ] **Step 3: Run focused tests and confirm they fail**

Run:

```bash
npx tsx --test \
  test/json-output.test.ts \
  test/process-runner.test.ts \
  test/job-manager.test.ts \
  test/job-status.test.ts \
  test/dashboard.test.ts
```

Expected: FAIL because the parser and downstream result types still retain malformed sample text and collection/dashboard output still contains sample labels.

- [ ] **Step 4: Remove malformed sample retention and propagation**

Make these minimal production changes:

1. In `src/json-stream.ts`, keep only the count:

```ts
import { StringDecoder } from "node:string_decoder";
import { CAPTURED_TEXT_MAX_BYTES } from "./output.ts";

// Remove _malformedSamples and the malformedSamples getter.

private malformed(): unknown[] {
  this._malformedCount += 1;
  return [];
}
```

Call `this.malformed()` without passing record text from `consume()` and `parse()`.

1. Remove `malformedEventSamples` from `ProcessResult` in `src/process-runner.ts` and from the object passed to `resolveResult()`.

1. Remove `malformedEventSamples` from `Job` in `src/types.ts`.

1. In `src/job-manager.ts`, remove `MALFORMED_EVENT_SAMPLE_MAX_BYTES` from the import and delete the assignment that copies/truncates `result.malformedEventSamples`. Keep:

```ts
entry.job.malformedEventCount = result.malformedEventCount;
```

1. In `src/output.ts`, delete `MALFORMED_EVENT_SAMPLE_MAX_BYTES`. Replace failed-job malformed diagnostics with the count only:

```ts
`Malformed events: ${job.malformedEventCount}`,
```

1. In `src/dashboard.ts`, remove `malformedEventSamples` from `renderFingerprint()`. Replace the full-view malformed value with:

```ts
const malformed = `${job.malformedEventCount} malformed protocol event${job.malformedEventCount === 1 ? "" : "s"}.`;
```

Do not remove dashboard display of captured output, stderr, error, or progress; those are memory-only inspection features and outside this change.

- [ ] **Step 5: Update exact-output tests and README wording**

In `test/json-output.test.ts`, update failed-result expected strings by replacing:

```text
Malformed events: 0
Malformed samples:
none
```

with:

```text
Malformed events: 0
```

Remove the `MALFORMED_EVENT_SAMPLE_MAX_BYTES` import and all sample-size assertions.

In `README.md`, add this sentence after the `subagent_status` privacy paragraph:

```md
Tool-result details contain only bounded renderer metadata and never store complete job snapshots. Malformed protocol records are counted, but their raw text is discarded.
```

Keep the existing statement that explicit collection returns the selected result and that uncollected inbox data is memory-only.

- [ ] **Step 6: Verify no malformed sample path remains**

Run:

```bash
rg -n "malformedEventSamples|malformedSamples|MALFORMED_EVENT_SAMPLE" src test README.md
```

Expected: no matches and exit code 1 from `rg`.

Then run:

```bash
npx tsx --test \
  test/json-output.test.ts \
  test/process-runner.test.ts \
  test/job-manager.test.ts \
  test/job-status.test.ts \
  test/dashboard.test.ts
npm run typecheck
```

Expected: all tests and typecheck PASS.

- [ ] **Step 7: Run complete verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Expected:

- The suite reports no failures or cancellations.
- The existing two integration tests remain the only skipped tests.
- TypeScript reports no errors.
- `git diff --check` reports no whitespace errors.

- [ ] **Step 8: Commit malformed-text removal and documentation**

```bash
git add \
  src/json-stream.ts \
  src/process-runner.ts \
  src/job-manager.ts \
  src/types.ts \
  src/output.ts \
  src/dashboard.ts \
  test/json-output.test.ts \
  test/process-runner.test.ts \
  test/job-manager.test.ts \
  test/job-status.test.ts \
  test/dashboard.test.ts \
  README.md
git commit -m "fix: discard malformed subagent protocol text"
```
