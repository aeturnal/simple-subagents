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

### Task 2: Stop malformed text at the capture boundary

**Files:**

- Modify: `src/json-stream.ts:1-58`
- Modify: `src/process-runner.ts:20-33,285-306`
- Modify: `src/job-manager.ts:1-5,431-453`
- Test: `test/json-output.test.ts:31-117`
- Test: `test/process-runner.test.ts:495-516`
- Test: `test/job-manager.test.ts:617-645`
- Test: `test/tools.test.ts:237-290`

**Interfaces:**

- Preserves: `JsonLineParser.malformedCount`, `ProcessResult.malformedEventCount`, and `Job.malformedEventCount`.
- Removes: `JsonLineParser.malformedSamples` and `ProcessResult.malformedEventSamples`.
- Stops: `JobManager` from assigning malformed raw text to new jobs.
- Temporarily preserves: the optional legacy `Job.malformedEventSamples` field so output and dashboard cleanup can be reviewed separately in Task 3.

- [ ] **Step 1: Add the failing parser privacy test**

In `test/json-output.test.ts`, change the blank-record test to assert `parser.malformedCount === 1` instead of inspecting a sample. Replace the tests named `"counts malformed records and retains three 500-character samples"` and `"bounds malformed samples at a UTF-8-safe byte limit"` with:

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

Remove the now-unused `MALFORMED_EVENT_SAMPLE_MAX_BYTES` import and every `parser.malformedSamples` assertion from this parser test section. Leave the failed collection formatting tests unchanged until Task 3.

- [ ] **Step 2: Add failing runner and manager assertions**

In `test/process-runner.test.ts`, rename the capture-bound test to `"bounds captured output, stderr, and assistant errors without returning malformed text"`. Keep its malformed stdout line and replace sample assertions with:

```ts
assert.equal(result.malformedEventCount, 1);
assert.equal("malformedEventSamples" in result, false);
assert.doesNotMatch(JSON.stringify(result), /not-json-/u);
```

In `test/job-manager.test.ts`, remove `malformedEventSamples` from the failed process result and expected job. Add:

```ts
const stored = manager.get(job.id);
assert.equal(stored?.malformedEventCount, 2);
assert.equal(stored && "malformedEventSamples" in stored, false);
```

In the single-status setup in `test/tools.test.ts`, remove the `malformedEventSamples` override from `completed(...)`. Keep the grouped fake-job sample until Task 3 so Task 1 continues checking that projections reject legacy private fields.

- [ ] **Step 3: Run capture tests and confirm they fail**

Run:

```bash
npx tsx --test \
  test/json-output.test.ts \
  test/process-runner.test.ts \
  test/job-manager.test.ts \
  test/tools.test.ts
```

Expected: FAIL because the parser still retains malformed text, the process result still returns it, and the manager still copies it into jobs.

- [ ] **Step 4: Remove malformed text from the capture path**

In `src/json-stream.ts`, keep only the count:

```ts
import { StringDecoder } from "node:string_decoder";
import { CAPTURED_TEXT_MAX_BYTES } from "./output.ts";

private malformed(): unknown[] {
  this._malformedCount += 1;
  return [];
}
```

Delete `_malformedSamples` and its getter. Call `this.malformed()` without passing record text from `consume()` and `parse()`.

In `src/process-runner.ts`, remove `malformedEventSamples` from `ProcessResult` and from the object passed to `resolveResult()`. Keep:

```ts
malformedEventCount: parser.malformedCount,
```

In `src/job-manager.ts`, remove `MALFORMED_EVENT_SAMPLE_MAX_BYTES` from the import and delete the assignment that copies and truncates `result.malformedEventSamples`. Keep:

```ts
entry.job.malformedEventCount = result.malformedEventCount;
```

Do not remove `Job.malformedEventSamples`, collection formatting, or dashboard rendering in this task.

- [ ] **Step 5: Run capture tests and typecheck**

Run:

```bash
npx tsx --test \
  test/json-output.test.ts \
  test/process-runner.test.ts \
  test/job-manager.test.ts \
  test/tools.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck PASS. New jobs retain the malformed count but no raw malformed text reaches `ProcessResult` or `JobManager`.

- [ ] **Step 6: Commit the capture-boundary fix**

```bash
git add \
  src/json-stream.ts \
  src/process-runner.ts \
  src/job-manager.ts \
  test/json-output.test.ts \
  test/process-runner.test.ts \
  test/job-manager.test.ts \
  test/tools.test.ts
git commit -m "fix: discard malformed protocol text at capture"
```

---

### Task 3: Remove obsolete malformed-sample storage and display

**Files:**

- Modify: `src/types.ts:54-79`
- Modify: `src/output.ts:1-7,65-107`
- Modify: `src/dashboard.ts:26-52,236-277`
- Modify: `README.md:15-36,94-98`
- Test: `test/json-output.test.ts:183-317`
- Test: `test/job-status.test.ts:24-42`
- Test: `test/dashboard.test.ts:191-299`
- Test: `test/tools.test.ts:258-290`

**Interfaces:**

- Removes: the legacy optional `Job.malformedEventSamples` field and `MALFORMED_EVENT_SAMPLE_MAX_BYTES`.
- Preserves: `Job.malformedEventCount`, failed collection diagnostics, and dashboard malformed-event diagnostics.
- Preserves: collection output, normal output/stderr/error inspection, capture limits, and dashboard layout.

- [ ] **Step 1: Add failing collection and dashboard privacy tests**

In `test/json-output.test.ts`, replace the failed collection sample fixture with a deliberate legacy-shaped object:

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

In `test/dashboard.test.ts`, remove malformed samples from normal fixtures. Pass one legacy-shaped job to the full-view test:

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

Remove the obsolete malformed-sample fixtures from `test/job-status.test.ts` and the grouped status fixture in `test/tools.test.ts`.

- [ ] **Step 2: Run presentation tests and confirm they fail**

Run:

```bash
npx tsx --test \
  test/json-output.test.ts \
  test/job-status.test.ts \
  test/dashboard.test.ts \
  test/tools.test.ts
```

Expected: FAIL because collection and the full dashboard still display the raw legacy sample.

- [ ] **Step 3: Remove obsolete storage and displays**

In `src/types.ts`, remove:

```ts
malformedEventSamples?: string[];
```

In `src/output.ts`, delete `MALFORMED_EVENT_SAMPLE_MAX_BYTES`. Replace failed-job malformed diagnostics with the count only:

```ts
`Malformed events: ${job.malformedEventCount}`,
```

In `src/dashboard.ts`, remove `malformedEventSamples` from `renderFingerprint()`. Replace the full-view malformed value with:

```ts
const malformed = `${job.malformedEventCount} malformed protocol event${job.malformedEventCount === 1 ? "" : "s"}.`;
```

Do not remove dashboard display of captured output, stderr, error, or progress.

- [ ] **Step 4: Update exact-output tests and README wording**

In `test/json-output.test.ts`, update every failed-result expected string by replacing:

```text
Malformed events: 0
Malformed samples:
none
```

with:

```text
Malformed events: 0
```

In `README.md`, add this sentence after the `subagent_status` privacy paragraph:

```md
Tool-result details contain only bounded renderer metadata and never store complete job snapshots. Malformed protocol records are counted, but their raw text is discarded.
```

Keep the existing statements about explicit collection and the memory-only inbox.

- [ ] **Step 5: Verify the obsolete sample path is gone**

Run:

```bash
rg -n "malformedEventSamples|malformedSamples|MALFORMED_EVENT_SAMPLE" src test README.md
```

Expected: the only matches are the two deliberate legacy-shaped regression objects in `test/json-output.test.ts` and `test/dashboard.test.ts`. No production match remains.

Run focused verification:

```bash
npx tsx --test \
  test/json-output.test.ts \
  test/job-status.test.ts \
  test/dashboard.test.ts \
  test/tools.test.ts
npm run typecheck
```

Expected: all focused tests and typecheck PASS.

- [ ] **Step 6: Run complete verification**

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

- [ ] **Step 7: Commit malformed-sample cleanup and documentation**

```bash
git add \
  src/types.ts \
  src/output.ts \
  src/dashboard.ts \
  test/json-output.test.ts \
  test/job-status.test.ts \
  test/dashboard.test.ts \
  test/tools.test.ts \
  README.md
git commit -m "fix: remove malformed protocol sample display"
```
