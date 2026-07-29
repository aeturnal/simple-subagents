# Richer Bounded Subagent Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make single-job `subagent_status` calls report bounded timing, profile, access, model, cancellation, usage, and sanitized recent activity metadata without exposing any uncollected answer content.

**Architecture:** Add lifecycle visibility to immutable `Job` snapshots, generate public activity summaries at the process-runner boundary, and map snapshots through a new pure `status.ts` DTO/formatter boundary. The status tool will put only those bounded DTOs in `details.statuses`, preserve `details.jobs` for compatibility, cap model-visible content at 50 KiB, and keep all-job status compact.

**Tech Stack:** TypeScript 5.9, Node.js 22.19 built-ins, Pi extension/TUI APIs, TypeBox, Node's test runner through `tsx`.

## Global Constraints

- Start from the released Plans 01–04 state; preserve stale-safe notifications, `subagent_wait`, `subagent_agents`, and per-job launch metadata unchanged.
- `progressLimit` is optional, is an integer from `0` through `3`, and defaults to `1` for single-job status.
- Supplying `progressLimit` without `id` returns a validation diagnostic; all-job listings never include progress tails.
- Existing `{}` and `{ id }` status calls remain valid.
- Raw `ProgressItem.text` is never a public status source, regardless of progress type.
- Public summaries contain only allowlisted event phases and sanitized tool names or fixed extension-owned diagnostics; never arguments, results, stderr, parser samples, exception messages, provider text, partial prose, or final output.
- Each public summary is UTF-8-safe and no larger than `512` bytes at creation and formatting boundaries.
- Single-job status returns at most `3` public activity items, newest last.
- Running duration is `now - startedAt`, terminal duration is `finishedAt - startedAt`, and queue duration is `startedAt - createdAt`; missing or skewed timestamps never produce negative durations.
- `cancellationRequested` remains true after cancellation starts, including after the job reaches a terminal state.
- `usageRecorded` becomes true only when `JobManager.applyResult()` records a process result, including an all-zero result.
- Without per-job model overrides, model visibility uses `job.model`, then the explicit profile model, then `inherits parent` when inheritance is the only known fact; do not add model resolution or live model validation.
- Model-visible status content is capped at `50 KiB`; multi-job output includes complete lines in stable job order and then an omitted-job count, never a partial line or character.
- `details.jobs` remains present and unchanged for compatibility; new rendering consumes bounded `details.statuses` DTOs.
- Keep the extension memory-only and add no dependency, live-usage callback, persistence, stuck detector, or dashboard redesign.

---

## File Structure

- `src/types.ts` — add public lifecycle flags, parent-inheritance knowledge, and separately generated public progress summaries.
- `src/job-manager.ts` — maintain lifecycle flags, preserve inherited-model knowledge, and expose the manager's injected clock without changing job states.
- `src/process-runner.ts` — generate allowlisted, sanitized, 512-byte public tool summaries separately from opaque progress text.
- `src/status.ts` — own bounded public status DTOs, duration calculations, activity filtering, and single/all-job text formatting.
- `src/tools.ts` — extend the schema, validate single-job-only progress tails, attach `details.statuses`, and render status DTOs.
- `test/job-manager.test.ts` — cover cancellation intent, usage availability, inherited-model knowledge, and the injected clock.
- `test/process-runner.test.ts` — cover summary phase allowlisting, tool-name sanitization, and private event-data exclusion.
- `test/status.test.ts` — cover the pure DTO/formatter boundary, every state, timing, privacy, UTF-8 limits, and aggregate bounds.
- `test/tools.test.ts` — cover schema/default compatibility, execution diagnostics, DTO isolation, and compact/expanded/narrow rendering.
- `README.md`, `test/package.test.ts` — document and lock the richer metadata-only status contract.

## Public Interfaces

```typescript
export interface ProgressItem {
  type: "text" | "tool" | "diagnostic";
  text: string;
  timestamp: number;
  publicSummary?: string;
  truncation?: TextTruncation;
}

export interface Job {
  // Existing fields remain unchanged.
  cancellationRequested?: boolean;
  usageRecorded?: boolean;
  inheritsParentModel?: boolean;
}

export interface PublicActivityItem {
  timestamp: number;
  summary: string;
}

export interface PublicJobStatus {
  id: string;
  state: JobState;
  agent: string;
  access: AccessMode;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  queueDurationMs?: number;
  runDurationMs?: number;
  launchModel?: string;
  launchThinking?: string;
  reportedModel?: string;
  model?: string;
  cancellationRequested: boolean;
  usageRecorded: boolean;
  usage?: UsageStats;
  latestProgressAt?: number;
  recentActivity: PublicActivityItem[];
}

export function toPublicJobStatus(job: Job, now: number, progressLimit: number): PublicJobStatus;
export function formatSingleJobStatus(status: PublicJobStatus, now: number): string;
export function formatStatusList(statuses: readonly PublicJobStatus[]): string;

export interface ToolDetails {
  jobs: Job[];
  statuses?: PublicJobStatus[];
  diagnostics: string[];
  operation?: "agents" | "start" | "status" | "wait" | "cancel" | "collect" | "discard";
}
```

`JobManager.currentTime(): number` returns the same injected clock used by queue/start/finish transitions. `statusJobs()` calls it once per request so every DTO and duration in one response has a consistent time basis.

---

### Task 1: Expose lifecycle metadata on immutable job snapshots

**Files:**
- Modify: `src/types.ts:39-66`
- Modify: `src/job-manager.ts:11-16,49-88,91-113,145-170,239-240,295-326`
- Test: `test/job-manager.test.ts` (append focused metadata tests)

**Interfaces:**
- Consumes: the existing injected `JobManager` `now` function and process-result application path.
- Produces: manager-populated optional `Job.cancellationRequested`, `Job.usageRecorded`, `Job.inheritsParentModel`, and `JobManager.currentTime(): number`; optional typing keeps existing hand-built fixtures compatible.
- Invariant: cancellation intent has one source of truth on `entry.job`; usage availability changes only in `applyResult()`.

- [ ] **Step 1: Write failing manager tests for the new snapshot metadata**

Append to `test/job-manager.test.ts`:

```typescript
test("publishes cancellation intent before and after the terminal transition", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  const [running, queued] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(running && queued);

  const cancelling = manager.cancel(running.id);
  assert.equal(manager.get(running.id)?.cancellationRequested, true);
  assert.equal(manager.get(running.id)?.state, "running");

  const queuedCancelled = await manager.cancel(queued.id);
  assert.equal(queuedCancelled.cancellationRequested, true);
  assert.equal(queuedCancelled.state, "cancelled");

  runner.releaseCancel(0);
  const cancelled = await cancelling;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.cancellationRequested, true);
});

test("distinguishes unavailable usage from a recorded all-zero result", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  assert.equal(job.usageRecorded, false);

  runner.complete(0, {
    ...successfulResult("done"),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  });
  await runner.flush();

  const completed = manager.get(job.id);
  assert.equal(completed?.usageRecorded, true);
  assert.deepEqual(completed?.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
});

test("records parent inheritance knowledge and exposes the injected clock", () => {
  let now = 125;
  const manager = new JobManager({ runner: new ControlledRunner(), now: () => now });
  const [inherited] = manager.enqueue(makeRequests(1), profiles, defaults);
  const explicitProfiles = new Map([[profile.name, { ...profile, model: "profile/model" }]]);
  const [explicit] = manager.enqueue(makeRequests(1), explicitProfiles, defaults);

  assert.equal(inherited?.inheritsParentModel, true);
  assert.equal(explicit?.inheritsParentModel, false);
  assert.equal(manager.currentTime(), 125);
  now = 250;
  assert.equal(manager.currentTime(), 250);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="publishes cancellation intent|distinguishes unavailable usage|records parent inheritance"
```

Expected: FAIL because the three `Job` fields and `currentTime()` do not exist.

- [ ] **Step 3: Add manager-populated snapshot fields and use the public cancellation flag as the source of truth**

In `src/types.ts`, add these optional fields after `finishedAt` so existing external snapshots and hand-built fixtures remain source-compatible:

```typescript
  cancellationRequested?: boolean;
  usageRecorded?: boolean;
  inheritsParentModel?: boolean;
```

In `src/job-manager.ts`, remove `cancellationRequested` from `InternalJob`, delete the outer `cancellationRequested: false,` property from each `InternalJob` initializer, initialize the public fields in each enqueued `job`, and add the clock accessor after `get()`:

```typescript
      job: {
        id: `job-${this.nextId++}`,
        request: structuredClone(request),
        profile: structuredClone(profile),
        state: "queued",
        createdAt,
        cancellationRequested: false,
        usageRecorded: false,
        inheritsParentModel: profile.model === undefined && defaults.parentModel !== undefined,
        progress: [],
        output: "",
        stderr: "",
        usage: emptyUsage(),
        malformedEventCount: 0,
      },
```

```typescript
  currentTime(): number {
    return this.now();
  }
```

Replace every internal cancellation read/write with the public field. The affected statements become:

```typescript
    entry.job.cancellationRequested = true;
```

```typescript
        entry.job.cancellationRequested = true;
```

```typescript
    for (const [id] of running) this.requireJob(id).job.cancellationRequested = true;
    for (const [id] of starting) this.requireJob(id).job.cancellationRequested = true;
```

```typescript
      if (entry.job.cancellationRequested) {
```

```typescript
      this.finish(entry, forceFailure ? "failed" : entry.job.cancellationRequested ? "cancelled" : this.resultState(result));
```

Immediately after copying `result.usage` in `applyResult()`, record availability:

```typescript
    entry.job.usage = structuredClone(result.usage);
    entry.job.usageRecorded = true;
```

- [ ] **Step 4: Run manager tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/job-manager.test.ts
npm run typecheck
```

Expected: all manager tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit the lifecycle snapshot boundary**

```bash
git add src/types.ts src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: expose subagent lifecycle metadata"
```

---

### Task 2: Generate sanitized public tool summaries at the runner boundary

**Files:**
- Modify: `src/types.ts:39-45`
- Modify: `src/process-runner.ts:180-190,271-274`
- Test: `test/process-runner.test.ts` (append focused public-summary tests)

**Interfaces:**
- Consumes: Pi JSON events and `truncateUtf8(text, maxBytes)`.
- Produces: optional `ProgressItem.publicSummary`; `tool_execution_start` yields `Started <safe-name>`, and `tool_execution_end` yields `Completed <safe-name>`.
- Sanitizer contract: tool names must match `/^[A-Za-z0-9_-]{1,64}$/`; every other value becomes `tool`. Update and result phases receive no public summary.

- [ ] **Step 1: Write failing tests for allowlisting, sanitization, and data isolation**

Append to `test/process-runner.test.ts`:

```typescript
test("creates public summaries only for allowlisted tool phases and sanitized names", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(),
    profile: profile({ systemPrompt: "" }),
    onProgress: (item) => progress.push(item),
  }));

  child.stdout.emit("data", Buffer.from([
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/private/answer" } }),
    JSON.stringify({ type: "tool_execution_update", toolName: "grep", partialResult: "private result" }),
    JSON.stringify({ type: "tool_execution_end", toolName: "grep", result: "private result" }),
    JSON.stringify({ type: "tool_result_end", result: "private result" }),
    JSON.stringify({ type: "tool_execution_start", toolName: "read /private/answer" }),
  ].join("\n") + "\n"));
  child.close();
  await running.result;

  assert.deepEqual(progress.map((item) => item.publicSummary), [
    "Started read",
    undefined,
    "Completed grep",
    undefined,
    "Started tool",
  ]);
  const publicText = progress.flatMap((item) => item.publicSummary ?? []).join("\n");
  assert.doesNotMatch(publicText, /private|answer|result/i);
});

test("keeps generated public summaries UTF-8-safe and within 512 bytes", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(),
    profile: profile({ systemPrompt: "" }),
    onProgress: (item) => progress.push(item),
  }));

  child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "tool_execution_start",
    toolName: "😀".repeat(300),
  })}\n`));
  child.close();
  await running.result;

  const summary = progress[0]?.publicSummary ?? "";
  assert.equal(summary, "Started tool");
  assert.ok(Buffer.byteLength(summary, "utf8") <= 512);
  assert.doesNotMatch(summary, /\uFFFD/);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test test/process-runner.test.ts --test-name-pattern="creates public summaries|generated public summaries"
```

Expected: FAIL because `ProgressItem.publicSummary` is absent and the runner emits only opaque `text`.

- [ ] **Step 3: Add the separately generated summary field**

In `src/types.ts`, extend `ProgressItem`:

```typescript
export interface ProgressItem {
  type: "text" | "tool" | "diagnostic";
  text: string;
  timestamp: number;
  publicSummary?: string;
  truncation?: TextTruncation;
}
```

- [ ] **Step 4: Generate only allowlisted public phases from sanitized names**

In `src/process-runner.ts`, add the constant and helper near the other constants:

```typescript
const PUBLIC_SUMMARY_MAX_BYTES = 512;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const publicToolName = (value: unknown): string => {
  const name = asString(value);
  return name !== undefined && SAFE_TOOL_NAME.test(name) ? name : "tool";
};
```

Replace `emitProgress` with:

```typescript
    const emitProgress = (text: string, publicSummary?: string) => options.onProgress({
      type: "tool",
      text,
      timestamp: Date.now(),
      publicSummary: publicSummary === undefined
        ? undefined
        : truncateUtf8(publicSummary, PUBLIC_SUMMARY_MAX_BYTES).text,
    });
```

Replace the four tool-event branches with:

```typescript
      if (record.type === "tool_execution_start") {
        const rawName = asString(record.toolName) ?? "tool";
        emitProgress(`Started ${rawName}`, `Started ${publicToolName(record.toolName)}`);
      } else if (record.type === "tool_execution_update") {
        emitProgress(`Updated ${asString(record.toolName) ?? "tool"}`);
      } else if (record.type === "tool_execution_end") {
        const rawName = asString(record.toolName) ?? "tool";
        emitProgress(`Completed ${rawName}`, `Completed ${publicToolName(record.toolName)}`);
      } else if (record.type === "tool_result_end") {
        emitProgress("Tool result received");
      }
```

The existing opaque `text` remains available internally; only `publicSummary` is eligible for public status.

- [ ] **Step 5: Run runner and manager tests to verify GREEN and preservation**

Run:

```bash
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts
npm run typecheck
```

Expected: all tests PASS, including existing bounded progress-history tests.

- [ ] **Step 6: Commit the public activity producer**

```bash
git add src/types.ts src/process-runner.ts test/process-runner.test.ts
git commit -m "feat: sanitize public subagent activity"
```

---

### Task 3: Build pure status DTO timing and metadata mapping

**Files:**
- Create: `src/status.ts`
- Create: `test/status.test.ts`

**Interfaces:**
- Consumes: immutable `Job` snapshots, one numeric `now`, and a validated `progressLimit`.
- Produces: `PublicActivityItem`, `PublicJobStatus`, and `toPublicJobStatus(job, now, progressLimit)` with agent/model strings sanitized through Plan 03's public-text boundary.
- Duration helper contract: clamp each computed millisecond duration to zero; omit it when a required timestamp is absent.

- [ ] **Step 1: Write failing DTO tests for all states, timing, usage, and model fallback**

Create `test/status.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { toPublicJobStatus } from "../src/status.ts";
import type { Job, JobState } from "../src/types.ts";

const job = (state: JobState, overrides: Partial<Job> = {}): Job => ({
  id: "job-4",
  request: { task: "private task", agent: "reviewer", writeAccess: false },
  profile: { name: "reviewer", description: "Reviews", systemPrompt: "private prompt", source: "user" },
  state,
  createdAt: 1_000,
  startedAt: state === "queued" ? undefined : 2_000,
  finishedAt: ["completed", "failed", "cancelled", "collected", "discarded"].includes(state) ? 5_000 : undefined,
  cancellationRequested: state === "cancelled",
  usageRecorded: state !== "queued" && state !== "running",
  inheritsParentModel: true,
  progress: [],
  output: "private final output",
  stderr: "private stderr",
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 6 },
  errorMessage: "private error",
  malformedEventCount: 1,
  malformedEventSamples: ["private malformed sample"],
  ...overrides,
});

test("maps queued, running, and every terminal state with deterministic durations", () => {
  const queued = toPublicJobStatus(job("queued"), 8_000, 1);
  assert.equal(queued.queueDurationMs, undefined);
  assert.equal(queued.runDurationMs, undefined);

  const running = toPublicJobStatus(job("running"), 8_000, 1);
  assert.equal(running.queueDurationMs, 1_000);
  assert.equal(running.runDurationMs, 6_000);

  for (const state of ["completed", "failed", "cancelled", "collected", "discarded"] as const) {
    const terminal = toPublicJobStatus(job(state), 8_000, 1);
    assert.equal(terminal.state, state);
    assert.equal(terminal.queueDurationMs, 1_000);
    assert.equal(terminal.runDurationMs, 3_000);
  }
});

test("clamps skewed durations and omits durations with missing timestamps", () => {
  const skewed = toPublicJobStatus(job("running", { createdAt: 5_000, startedAt: 4_000 }), 3_000, 1);
  assert.equal(skewed.queueDurationMs, 0);
  assert.equal(skewed.runDurationMs, 0);

  const missing = toPublicJobStatus(job("failed", { startedAt: undefined, finishedAt: 5_000 }), 8_000, 1);
  assert.equal(missing.queueDurationMs, undefined);
  assert.equal(missing.runDurationMs, undefined);
});

test("maps profile, access, cancellation, usage availability, and model precedence", () => {
  const reported = toPublicJobStatus(job("completed", {
    launchModel: "launch/model",
    launchThinkingLevel: "high",
    launchThinkingSource: "job",
    model: "reported/model",
  }), 8_000, 1);
  assert.equal(reported.launchModel, "launch/model");
  assert.equal(reported.launchThinking, "high (job override)");
  assert.equal(reported.reportedModel, "reported/model");
  assert.equal(reported.agent, "reviewer");
  assert.equal(reported.access, "read-only");
  assert.equal(reported.cancellationRequested, false);
  assert.deepEqual(reported.usage, job("completed").usage);

  const configured = toPublicJobStatus(job("running", {
    request: { task: "private", agent: "reviewer", writeAccess: true },
    profile: { ...job("running").profile, model: "profile/model" },
    usageRecorded: false,
  }), 8_000, 1);
  assert.equal(configured.model, "profile/model");
  assert.equal(configured.access, "write");
  assert.equal(configured.usage, undefined);

  const inherited = toPublicJobStatus(job("running", { usageRecorded: false }), 8_000, 1);
  assert.equal(inherited.model, "inherits parent");

  const unknown = toPublicJobStatus(job("running", { inheritsParentModel: false, usageRecorded: false }), 8_000, 1);
  assert.equal(unknown.model, undefined);

  const sanitized = toPublicJobStatus(job("running", {
    profile: { ...job("running").profile, name: " reviewer\n\u0000name " },
    launchModel: `provider/${"界".repeat(300)}`,
    model: "reported\nmodel",
  }), 8_000, 1);
  assert.equal(sanitized.agent, "reviewer name");
  assert.ok(Buffer.byteLength(sanitized.launchModel ?? "", "utf8") <= 512);
  assert.equal(sanitized.reportedModel, "reported model");
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```bash
npx tsx --test test/status.test.ts
```

Expected: FAIL with `Cannot find module '../src/status.ts'`.

- [ ] **Step 3: Create the DTO mapper with no formatting or private fields**

Create `src/status.ts`:

```typescript
import { sanitizePublicText } from "./profile-discovery.js";
import type { AccessMode, Job, JobState, UsageStats } from "./types.js";

export const PUBLIC_SUMMARY_MAX_BYTES = 512;
export const STATUS_CONTENT_MAX_BYTES = 50 * 1024;

export interface PublicActivityItem {
  timestamp: number;
  summary: string;
}

export interface PublicJobStatus {
  id: string;
  state: JobState;
  agent: string;
  access: AccessMode;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  queueDurationMs?: number;
  runDurationMs?: number;
  launchModel?: string;
  launchThinking?: string;
  reportedModel?: string;
  model?: string;
  cancellationRequested: boolean;
  usageRecorded: boolean;
  usage?: UsageStats;
  latestProgressAt?: number;
  recentActivity: PublicActivityItem[];
}

const nonNegativeDifference = (end: number | undefined, start: number | undefined): number | undefined =>
  end === undefined || start === undefined ? undefined : Math.max(0, end - start);

const launchThinking = (job: Job): string | undefined => {
  if (!job.launchThinkingLevel) return undefined;
  const source = job.launchThinkingSource === "job" ? "job override"
    : job.launchThinkingSource === "parent" ? "parent session"
      : "legacy profile/parent behavior";
  return `${job.launchThinkingLevel} (${source})`;
};

const fallbackModel = (job: Job): string | undefined =>
  job.launchModel === undefined && job.model === undefined
    ? job.profile.model ?? (job.inheritsParentModel ? "inherits parent" : undefined)
    : undefined;

export const toPublicJobStatus = (job: Job, now: number, _progressLimit: number): PublicJobStatus => ({
  id: job.id,
  state: job.state,
  agent: sanitizePublicText(job.profile.name, 128),
  access: job.request.writeAccess ? "write" : "read-only",
  createdAt: job.createdAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  queueDurationMs: nonNegativeDifference(job.startedAt, job.createdAt),
  runDurationMs: nonNegativeDifference(job.finishedAt ?? (job.state === "running" ? now : undefined), job.startedAt),
  launchModel: job.launchModel ? sanitizePublicText(job.launchModel, 512) : undefined,
  launchThinking: launchThinking(job),
  reportedModel: job.model ? sanitizePublicText(job.model, 512) : undefined,
  model: fallbackModel(job) ? sanitizePublicText(fallbackModel(job) ?? "", 512) : undefined,
  cancellationRequested: job.cancellationRequested ?? false,
  usageRecorded: job.usageRecorded ?? false,
  usage: job.usageRecorded ? structuredClone(job.usage) : undefined,
  latestProgressAt: job.progress.at(-1)?.timestamp,
  recentActivity: [],
});
```

The DTO deliberately has no task, prompt, output, stderr, error, malformed sample, stop reason, or opaque progress text field.

- [ ] **Step 4: Run the DTO tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/status.test.ts
npm run typecheck
```

Expected: all three status tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit the pure metadata mapper**

```bash
git add src/status.ts test/status.test.ts
git commit -m "feat: map bounded subagent status metadata"
```

---

### Task 4: Filter and bound public recent activity

**Files:**
- Modify: `src/status.ts` (`toPublicJobStatus` activity mapping)
- Test: `test/status.test.ts` (append privacy and ordering tests)

**Interfaces:**
- Consumes: only `ProgressItem.publicSummary`, never `ProgressItem.text`.
- Produces: `latestProgressAt` from the newest progress item and `recentActivity` from the newest eligible `0..3` summaries, in chronological order.
- Defensive behavior: clamp direct mapper limits to `0..3` and re-truncate every public summary to 512 UTF-8 bytes.

- [ ] **Step 1: Write failing tests for limits, ordering, latest time, and private-data exclusion**

Append to `test/status.test.ts`:

```typescript
test("uses only public summaries with zero, default-sized, and maximum tails", () => {
  const source = job("running", {
    progress: [
      { type: "tool", text: "argument /private/one", publicSummary: "Started read", timestamp: 2_100 },
      { type: "text", text: "partial secret answer", timestamp: 2_200 },
      { type: "diagnostic", text: "provider secret", timestamp: 2_300 },
      { type: "tool", text: "result private two", publicSummary: "Completed read", timestamp: 2_400 },
      { type: "tool", text: "argument private three", publicSummary: "Started grep", timestamp: 2_500 },
      { type: "tool", text: "result private four", publicSummary: "Completed grep", timestamp: 2_600 },
      { type: "text", text: "newest private prose", timestamp: 2_700 },
    ],
  });

  assert.deepEqual(toPublicJobStatus(source, 8_000, 0).recentActivity, []);
  assert.deepEqual(toPublicJobStatus(source, 8_000, 1).recentActivity, [
    { timestamp: 2_600, summary: "Completed grep" },
  ]);
  assert.deepEqual(toPublicJobStatus(source, 8_000, 3).recentActivity, [
    { timestamp: 2_400, summary: "Completed read" },
    { timestamp: 2_500, summary: "Started grep" },
    { timestamp: 2_600, summary: "Completed grep" },
  ]);
  assert.equal(toPublicJobStatus(source, 8_000, 3).latestProgressAt, 2_700);
});

test("re-truncates public summaries at a UTF-8-safe 512-byte formatting boundary", () => {
  const source = job("running", {
    progress: [{
      type: "diagnostic",
      text: "private diagnostic body",
      publicSummary: "😀".repeat(200),
      timestamp: 2_100,
    }],
  });

  const summary = toPublicJobStatus(source, 8_000, 3).recentActivity[0]?.summary ?? "";
  assert.ok(Buffer.byteLength(summary, "utf8") <= 512);
  assert.equal(Buffer.from(summary, "utf8").toString("utf8"), summary);
  assert.doesNotMatch(summary, /\uFFFD/);
});

test("public DTOs contain no private job or opaque progress fields", () => {
  const status = toPublicJobStatus(job("failed", {
    output: "final secret",
    stderr: "stderr secret",
    errorMessage: "error secret",
    malformedEventSamples: ["sample secret"],
    progress: [{ type: "text", text: "partial secret", timestamp: 2_100 }],
  }), 8_000, 3);
  const serialized = JSON.stringify(status);

  for (const secret of ["final secret", "stderr secret", "error secret", "sample secret", "partial secret", "private task", "private prompt"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const key of ["output", "stderr", "errorMessage", "malformedEventSamples", "text", "task", "systemPrompt"]) {
    assert.equal(key in status, false, key);
  }
});
```

- [ ] **Step 2: Run focused activity tests and verify RED**

Run:

```bash
npx tsx --test test/status.test.ts --test-name-pattern="uses only public summaries|re-truncates public summaries|contain no private"
```

Expected: the first two tests FAIL because `recentActivity` is always empty.

- [ ] **Step 3: Implement defensive public-summary filtering**

Add this import to `src/status.ts`:

```typescript
import { truncateUtf8 } from "./output.js";
```

Add this helper below `fallbackModel`:

```typescript
const recentActivity = (job: Job, progressLimit: number): PublicActivityItem[] => {
  const limit = Math.max(0, Math.min(3, Math.trunc(progressLimit)));
  if (limit === 0) return [];
  return job.progress
    .filter((item) => item.publicSummary !== undefined)
    .slice(-limit)
    .map((item) => ({
      timestamp: item.timestamp,
      summary: truncateUtf8(item.publicSummary ?? "", PUBLIC_SUMMARY_MAX_BYTES).text,
    }));
};
```

Change the mapper parameter and final property:

```typescript
export const toPublicJobStatus = (job: Job, now: number, progressLimit: number): PublicJobStatus => ({
```

```typescript
  recentActivity: recentActivity(job, progressLimit),
```

- [ ] **Step 4: Run all status and runner tests to verify GREEN**

Run:

```bash
npx tsx --test test/status.test.ts test/process-runner.test.ts
npm run typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 5: Commit the public progress boundary**

```bash
git add src/status.ts test/status.test.ts
git commit -m "feat: bound public subagent progress tails"
```

---

### Task 5: Format single and aggregate model-visible status within hard bounds

**Files:**
- Modify: `src/status.ts` (add pure formatting functions)
- Test: `test/status.test.ts` (append formatter tests)

**Interfaces:**
- Consumes: `PublicJobStatus` only.
- Produces: `formatSingleJobStatus(status, now)` and `formatStatusList(statuses)`.
- Text contract: seconds use one decimal place; all-list lines are `id: state · agent · access`; aggregate truncation emits `<N> jobs omitted.` as a complete final line.

- [ ] **Step 1: Write failing single-job formatting and privacy tests**

Update the import in `test/status.test.ts`:

```typescript
import {
  STATUS_CONTENT_MAX_BYTES,
  formatSingleJobStatus,
  formatStatusList,
  toPublicJobStatus,
} from "../src/status.ts";
```

Append:

```typescript
test("formats rich running and terminal status without misleading zero usage", () => {
  const running = toPublicJobStatus(job("running", {
    progress: [{ type: "tool", text: "private args", publicSummary: "Started read", timestamp: 5_900 }],
    usageRecorded: false,
    model: "anthropic/claude-sonnet-4-5",
  }), 8_000, 1);
  const runningText = formatSingleJobStatus(running, 8_000);

  for (const expected of [
    "job-4: running",
    "Agent: reviewer",
    "Access: read-only",
    "Created: 1970-01-01T00:00:01.000Z",
    "Started: 1970-01-01T00:00:02.000Z",
    "Queue: 1.0s",
    "Elapsed: 6.0s",
    "Reported model: anthropic/claude-sonnet-4-5",
    "Cancellation requested: no",
    "Usage: not yet available",
    "Latest progress: 2.1s ago",
    "- Started read",
  ]) assert.ok(runningText.includes(expected), expected);
  assert.doesNotMatch(runningText, /private args|private task|final output|stderr/i);

  const terminal = formatSingleJobStatus(toPublicJobStatus(job("cancelled", {
    cancellationRequested: true,
    usageRecorded: true,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  }), 8_000, 0), 8_000);
  assert.match(terminal, /Finished: 1970-01-01T00:00:05.000Z/);
  assert.match(terminal, /Duration: 3.0s/);
  assert.match(terminal, /Cancellation requested: yes/);
  assert.match(terminal, /Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0/);
  assert.doesNotMatch(terminal, /Recent activity:/);
});

test("clamps latest-progress age and caps single-job content safely", () => {
  const futureProgress = toPublicJobStatus(job("running", {
    progress: [{ type: "tool", text: "opaque", publicSummary: "Completed read", timestamp: 9_000 }],
  }), 8_000, 1);
  assert.match(formatSingleJobStatus(futureProgress, 8_000), /Latest progress: 0.0s ago/);

  const oversized = toPublicJobStatus(job("running", {
    profile: { ...job("running").profile, name: "😀".repeat(20_000) },
  }), 8_000, 0);
  const content = formatSingleJobStatus(oversized, 8_000);
  assert.ok(Buffer.byteLength(content, "utf8") <= STATUS_CONTENT_MAX_BYTES);
  assert.equal(Buffer.from(content, "utf8").toString("utf8"), content);
  assert.doesNotMatch(content, /\uFFFD/);
});
```

- [ ] **Step 2: Write failing aggregate bound and stable-order tests**

Append:

```typescript
test("formats compact all-job lines in stable order", () => {
  const statuses = [
    toPublicJobStatus(job("queued", { id: "job-1" }), 8_000, 0),
    toPublicJobStatus(job("running", { id: "job-2" }), 8_000, 0),
    toPublicJobStatus(job("failed", { id: "job-3" }), 8_000, 0),
  ];

  assert.equal(formatStatusList(statuses), [
    "Jobs: 3",
    "job-1: queued · reviewer · read-only",
    "job-2: running · reviewer · read-only",
    "job-3: failed · reviewer · read-only",
  ].join("\n"));
  assert.equal(formatStatusList([]), "No background subagent jobs.");
});

test("reserves a complete omitted-job line under the 50 KiB aggregate cap", () => {
  const statuses = Array.from({ length: 80 }, (_, index) => toPublicJobStatus(job("running", {
    id: `job-${index + 1}`,
    profile: { ...job("running").profile, name: `agent-${index}-${"x".repeat(1_500)}` },
  }), 8_000, 0));
  const content = formatStatusList(statuses);
  const lines = content.split("\n");

  assert.ok(Buffer.byteLength(content, "utf8") <= STATUS_CONTENT_MAX_BYTES);
  assert.equal(Buffer.from(content, "utf8").toString("utf8"), content);
  assert.match(lines.at(-1) ?? "", /^\d+ jobs omitted\.$/);
  assert.doesNotMatch(content, /\uFFFD/);
  for (const line of lines.slice(1, -1)) {
    assert.ok(statuses.some((status) => line === `${status.id}: ${status.state} · ${status.agent} · ${status.access}`));
  }
});
```

- [ ] **Step 3: Run formatter tests and verify RED**

Run:

```bash
npx tsx --test test/status.test.ts --test-name-pattern="formats rich|clamps latest|formats compact|reserves a complete"
```

Expected: FAIL because both formatter exports are missing.

- [ ] **Step 4: Implement single-job formatting from the DTO only**

Append to `src/status.ts`:

```typescript
const seconds = (milliseconds: number): string => `${(Math.max(0, milliseconds) / 1_000).toFixed(1)}s`;

const usageLine = (usage: UsageStats): string =>
  `Usage: input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}, cost ${usage.cost}, turns ${usage.turns}`;

export const formatSingleJobStatus = (status: PublicJobStatus, now: number): string => {
  const lines = [
    `${status.id}: ${status.state}`,
    `Agent: ${status.agent}`,
    `Access: ${status.access}`,
    `Created: ${new Date(status.createdAt).toISOString()}`,
    ...(status.startedAt === undefined ? [] : [`Started: ${new Date(status.startedAt).toISOString()}`]),
    ...(status.finishedAt === undefined ? [] : [`Finished: ${new Date(status.finishedAt).toISOString()}`]),
    ...(status.queueDurationMs === undefined ? [] : [`Queue: ${seconds(status.queueDurationMs)}`]),
    ...(status.runDurationMs === undefined
      ? []
      : [`${status.state === "running" ? "Elapsed" : "Duration"}: ${seconds(status.runDurationMs)}`]),
    ...(status.launchModel === undefined ? [] : [`Launch model: ${status.launchModel}`]),
    ...(status.launchThinking === undefined ? [] : [`Launch thinking: ${status.launchThinking}`]),
    ...(status.reportedModel === undefined ? [] : [`Reported model: ${status.reportedModel}`]),
    ...(status.model === undefined ? [] : [`Model: ${status.model}`]),
    `Cancellation requested: ${status.cancellationRequested ? "yes" : "no"}`,
    status.usageRecorded && status.usage ? usageLine(status.usage) : "Usage: not yet available",
    ...(status.latestProgressAt === undefined
      ? []
      : [`Latest progress: ${seconds(Math.max(0, now - status.latestProgressAt))} ago`]),
    ...(status.recentActivity.length === 0
      ? []
      : ["Recent activity:", ...status.recentActivity.map((item) => `- ${item.summary}`)]),
  ];
  return truncateUtf8(lines.join("\n"), STATUS_CONTENT_MAX_BYTES).text;
};
```

- [ ] **Step 5: Implement whole-line aggregate reservation**

Append to `src/status.ts`:

```typescript
const compactLine = (status: PublicJobStatus): string =>
  `${status.id}: ${status.state} · ${status.agent} · ${status.access}`;

const omittedLine = (count: number): string => `${count} job${count === 1 ? "" : "s"} omitted.`;

export const formatStatusList = (statuses: readonly PublicJobStatus[]): string => {
  if (statuses.length === 0) return "No background subagent jobs.";
  const lines = [`Jobs: ${statuses.length}`];

  for (let index = 0; index < statuses.length; index += 1) {
    const status = statuses[index];
    if (!status) continue;
    const remaining = statuses.length - index - 1;
    const candidate = [...lines, compactLine(status), ...(remaining > 0 ? [omittedLine(remaining)] : [])].join("\n");
    if (Buffer.byteLength(candidate, "utf8") <= STATUS_CONTENT_MAX_BYTES) {
      lines.push(compactLine(status));
      continue;
    }
    lines.push(omittedLine(statuses.length - index));
    break;
  }

  return lines.join("\n");
};
```

The previous iteration always reserved the exact omitted-count line needed by a later overflow, so the final append stays under the cap without removing or cutting an accepted job line.

- [ ] **Step 6: Run status tests and typecheck to verify GREEN**

Run:

```bash
npx tsx --test test/status.test.ts
npm run typecheck
```

Expected: all status tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit bounded status formatting**

```bash
git add src/status.ts test/status.test.ts
git commit -m "feat: format bounded subagent status"
```

---

### Task 6: Wire richer DTOs and progress limits into the status tool

**Files:**
- Modify: `src/tools.ts:19-59,92-103`
- Test: `test/tools.test.ts:1-20,143-170,389-405` and append focused status tests

**Interfaces:**
- Consumes: `JobManager.currentTime()`, `toPublicJobStatus()`, `formatSingleJobStatus()`, and `formatStatusList()`.
- Produces: `StatusParams` with optional integer `progressLimit`, `StatusToolResponse`, normal diagnostic `progressLimit requires id.`, and required bounded `details.statuses` on status responses.
- Defaults: direct and schema-backed single-job calls use `progressLimit ?? 1`; all-job mapping always passes `0`.

- [ ] **Step 1: Write failing schema and validation tests**

In the existing `registered tools expose strict schema boundaries and required guidance` test, change the status schema assertion block to:

```typescript
  const statusSchema = StatusParams as unknown as {
    properties: {
      id: { type: string };
      progressLimit: { type: string; minimum: number; maximum: number; default: number };
    };
  };
  assert.equal(statusSchema.properties.id.type, "string");
  assert.equal(statusSchema.properties.progressLimit.type, "integer");
  assert.equal(statusSchema.properties.progressLimit.minimum, 0);
  assert.equal(statusSchema.properties.progressLimit.maximum, 3);
  assert.equal(statusSchema.properties.progressLimit.default, 1);
```

Append:

```typescript
test("statusJobs rejects progressLimit without an ID while legacy all-job input remains valid", async () => {
  const { services } = createServices();
  const invalid = await statusJobs({ progressLimit: 1 }, services);
  const legacy = await statusJobs({}, services);

  assert.equal(text(invalid), "progressLimit requires id.");
  assert.deepEqual(invalid.details.diagnostics, ["progressLimit requires id."]);
  assert.deepEqual(invalid.details.statuses, []);
  assert.equal(text(legacy), "No background subagent jobs.");
});
```

- [ ] **Step 2: Write failing execution tests for defaults, explicit limits, and DTO isolation**

Append:

```typescript
test("statusJobs defaults to one public activity item and honors zero and three", async () => {
  let now = 0;
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, now: () => now });
  const { services } = createServices(runner, { manager });
  await startJobs({ tasks: [{ task: "private task" }] }, services, {} as never);
  now = 8_000;
  for (const [timestamp, textValue, publicSummary] of [
    [3_000, "private args one", "Started read"],
    [4_000, "private result one", "Completed read"],
    [5_000, "private args two", "Started grep"],
    [6_000, "private result two", "Completed grep"],
  ] as const) runner.started[0]?.options.onProgress({ type: "tool", text: textValue, publicSummary, timestamp });

  const defaulted = await statusJobs({ id: "job-1" }, services);
  const zero = await statusJobs({ id: "job-1", progressLimit: 0 }, services);
  const maximum = await statusJobs({ id: "job-1", progressLimit: 3 }, services);

  assert.deepEqual(defaulted.details.statuses?.[0]?.recentActivity.map((item) => item.summary), ["Completed grep"]);
  assert.deepEqual(zero.details.statuses?.[0]?.recentActivity, []);
  assert.deepEqual(maximum.details.statuses?.[0]?.recentActivity.map((item) => item.summary), [
    "Completed read", "Started grep", "Completed grep",
  ]);
  assert.match(text(defaulted), /Elapsed: 8\.0s/);
  assert.doesNotMatch(text(maximum), /private args|private result|private task/i);
  assert.equal("output" in maximum.details.statuses![0]!, false);
  assert.equal("stderr" in maximum.details.statuses![0]!, false);
  now = 9_000;
  assert.equal(manager.currentTime(), 9_000);
});

test("all-job status is compact, bounded, ordered, and never includes progress tails", async () => {
  const { services } = createServices();
  await startJobs({ tasks: [{ task: "private one" }, { task: "private two" }] }, services, {} as never);

  const result = await statusJobs({}, services);

  assert.match(text(result), /^Jobs: 2\njob-1: running/m);
  assert.match(text(result), /job-2: running/);
  assert.doesNotMatch(text(result), /Recent activity|private one|private two/);
  assert.deepEqual(result.details.statuses?.map((status) => status.recentActivity), [[], []]);
  assert.deepEqual(result.details.jobs.map((job) => job.id), ["job-1", "job-2"]);
});
```

- [ ] **Step 3: Run focused tool tests and verify RED**

Run:

```bash
npx tsx --test test/tools.test.ts --test-name-pattern="statusJobs rejects progressLimit|defaults to one public|all-job status|strict schema"
```

Expected: FAIL because the schema, `details.statuses`, and rich formatting are absent.

- [ ] **Step 4: Extend the schema and response details without renaming compatibility fields**

Add the status imports in `src/tools.ts`:

```typescript
import {
  formatSingleJobStatus,
  formatStatusList,
  toPublicJobStatus,
  type PublicJobStatus,
} from "./status.js";
```

Replace `StatusParams` with:

```typescript
export const StatusParams = Type.Object({
  id: Type.Optional(Type.String()),
  progressLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 1 })),
});
```

Extend `ToolDetails`:

```typescript
export interface ToolDetails {
  jobs: Job[];
  statuses?: PublicJobStatus[];
  diagnostics: string[];
  operation?: "agents" | "start" | "status" | "wait" | "cancel" | "collect" | "discard";
}
```

Leave the shared `response()` helper and Plan 02's wait response union unchanged. Add a narrowed status response and helper:

```typescript
export interface StatusToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails & {
    operation: "status";
    statuses: PublicJobStatus[];
  };
}

const statusResponse = (
  content: string,
  jobs: readonly Job[],
  diagnostics: string[],
  statuses: readonly PublicJobStatus[],
): StatusToolResponse => ({
  content: [{ type: "text", text: content }],
  details: {
    jobs: [...jobs],
    diagnostics,
    operation: "status",
    statuses: [...statuses],
  },
});
```

- [ ] **Step 5: Replace status execution with one-clock DTO mapping**

Replace `statusJobs()` in `src/tools.ts`:

```typescript
export async function statusJobs(input: StatusInput, services: ToolServices): Promise<StatusToolResponse> {
  if (!input.id && input.progressLimit !== undefined) {
    const diagnostic = "progressLimit requires id.";
    return statusResponse(diagnostic, [], [diagnostic], []);
  }

  const now = services.manager.currentTime();
  if (input.id) {
    const job = services.manager.get(input.id);
    if (!job) return statusResponse(`Unknown job: ${input.id}`, [], [`Unknown job: ${input.id}`], []);
    const status = toPublicJobStatus(job, now, input.progressLimit ?? 1);
    return statusResponse(formatSingleJobStatus(status, now), [job], [], [status]);
  }

  const jobs = services.manager.list();
  const statuses = jobs.map((job) => toPublicJobStatus(job, now, 0));
  return statusResponse(formatStatusList(statuses), jobs, [], statuses);
}
```

- [ ] **Step 6: Run tool, status, and type tests to verify GREEN**

Run:

```bash
npx tsx --test test/tools.test.ts test/status.test.ts
npm run typecheck
```

Expected: all tests PASS; unknown IDs retain `Unknown job: <id>`; existing `details.jobs` assertions remain valid.

- [ ] **Step 7: Commit the richer status tool contract**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: expose richer bounded status results"
```

---

### Task 7: Render compact and expanded status DTOs safely in the TUI

**Files:**
- Modify: `src/tools.ts:151-176`
- Test: `test/tools.test.ts:300-351` and append a narrow-width assertion

**Interfaces:**
- Consumes: `ToolDetails.statuses` and already bounded model-visible status `content`.
- Produces: one compact line per status DTO; expanded single-job rendering uses rich bounded content.
- Compatibility: start/control rendering continues using `details.jobs`; diagnostic-only status results continue rendering their actionable content; the existing wait-result and profile-discovery renderer branches remain earlier, unchanged branches.

- [ ] **Step 1: Update renderer expectations for rich expanded status**

In `tool renderers preserve task detail when expanded and keep compact control outcomes concise`, replace the single-status assertions with:

```typescript
  const successfulStatus = await statusJobs({ id: "job-1" }, services);
  const compactStatus = render("subagent_status", successfulStatus, false);
  assert.match(compactStatus, /Jobs: 1/);
  assert.match(compactStatus, /✓ job-1 completed/);
  assert.doesNotMatch(compactStatus, /one|collected secret/);
  const expandedStatus = render("subagent_status", successfulStatus, true);
  assert.match(expandedStatus, /job-1: completed/);
  assert.match(expandedStatus, /Agent: reviewer/);
  assert.match(expandedStatus, /Access: read-only/);
  assert.match(expandedStatus, /Duration:/);
  assert.match(expandedStatus, /Usage: input 1, output 2/);
  assert.doesNotMatch(expandedStatus, /one|collected secret/);
```

- [ ] **Step 2: Add failing compact multi-job and narrow-width tests**

Add `visibleWidth` to the TUI import used by the test file, then append:

```typescript
test("status renderer stays one-line compact and ANSI-width bounded", async () => {
  const pi = new FakePi();
  const { services } = createServices();
  registerSubagentTools(pi as never, services);
  await startJobs({ tasks: [{ task: "private one" }, { task: "private two" }] }, services, {} as never);
  const result = await statusJobs({}, services);
  const renderer = pi.tools.get("subagent_status")?.renderResult;
  assert.ok(renderer);
  const theme = { fg: (_color: string, value: string) => `\u001B[36m${value}\u001B[0m` };

  const compactLines = renderer(result, { expanded: false }, theme).render(28);
  assert.match(compactLines.join("\n"), /job-1/);
  assert.match(compactLines.join("\n"), /job-2/);
  assert.doesNotMatch(compactLines.join("\n"), /private one|private two/);
  for (const line of compactLines) assert.ok(visibleWidth(line) <= 28);

  const single = await statusJobs({ id: "job-1" }, services);
  const expandedLines = renderer(single, { expanded: true }, theme).render(24);
  assert.match(expandedLines.join("\n"), /Agent:/);
  for (const line of expandedLines) assert.ok(visibleWidth(line) <= 24);
});
```

Use this import at the top:

```typescript
import { visibleWidth } from "@earendil-works/pi-tui";
```

- [ ] **Step 3: Run renderer tests and verify RED**

Run:

```bash
npx tsx --test test/tools.test.ts --test-name-pattern="tool renderers preserve|status renderer stays"
```

Expected: FAIL because expanded status still renders the private task and status rendering still uses raw jobs.

- [ ] **Step 4: Add a DTO-specific rendering branch**

In `renderToolResult()`, keep Plan 02's specialized wait-result branch unchanged. After deriving `content` but before destructuring standard job details, add a narrowed status branch:

```typescript
if ("statuses" in result.details && result.details.operation === "status") {
  const statuses = result.details.statuses;
  if (statuses.length === 0) return theme.fg("muted", content);
  const compact = [
    `Jobs: ${statuses.length}`,
    ...statuses.map((status) => `${iconForState(status.state)} ${status.id} ${status.state}`),
  ].join("\n");
  return theme.fg("muted", expanded ? content : compact);
}
```

Then destructure the existing standard details as before:

```typescript
const { jobs, diagnostics, operation } = result.details;
```

Plan 03's profile-discovery tool keeps its separate `renderAgentProfiles()` renderer and requires no branch here.

This branch never reads task, output, stderr, errors, malformed samples, or opaque progress. Pi's existing `Text` component remains responsible for ANSI-aware wrapping at the render width.

- [ ] **Step 5: Run renderer, tool, and dashboard regression tests**

Run:

```bash
npx tsx --test test/tools.test.ts test/dashboard.test.ts
npm run typecheck
```

Expected: all tests PASS, including compact/expanded error diagnostics and all existing dashboard width checks.

- [ ] **Step 6: Commit DTO-backed status rendering**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: render richer subagent status"
```

---

### Task 8: Document metadata-only richer status and run the full verification suite

**Files:**
- Modify: `README.md:28`
- Modify: `test/package.test.ts` (append one documentation contract test)

**Interfaces:**
- Consumes: the completed public `subagent_status({ id, progressLimit })` behavior.
- Produces: user guidance that status reports metadata/activity but never the answer, and collection remains the only answer-delivery operation.

- [ ] **Step 1: Write a failing README contract test**

Append to `test/package.test.ts`:

```typescript
test("README documents richer status as metadata rather than answer delivery", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /subagent_status\(\{ id: "job-4", progressLimit: 3 \}\)/);
  assert.match(readme, /timing, profile, access, model, cancellation, usage, and sanitized recent activity/i);
  assert.match(readme, /never returns the subagent's partial or final answer/i);
  assert.match(readme, /collect.*answer/i);
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
npx tsx --test test/package.test.ts --test-name-pattern="README documents richer status"
```

Expected: FAIL because the README has no rich status example or metadata-only boundary.

- [ ] **Step 3: Add the exact richer-status guidance**

Add this paragraph immediately after the usage paragraph at `README.md:28`:

```markdown
For a bounded progress check, use `subagent_status({ id: "job-4", progressLimit: 3 })`. Single-job status can show timing, profile, access, model, cancellation, usage, and sanitized recent activity metadata. Status never returns the subagent's partial or final answer; use `subagent_control` with `collect` when you want the answer added to context. All-job status remains a compact state listing without activity tails.
```

- [ ] **Step 4: Run the documentation and complete project verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: every test in `test/*.test.ts` PASS and TypeScript reports no errors.

- [ ] **Step 5: Review the final diff for forbidden status data paths**

Run:

```bash
git diff --check
git diff -- src/status.ts src/tools.ts src/process-runner.ts src/job-manager.ts src/types.ts README.md test/status.test.ts test/tools.test.ts test/process-runner.test.ts test/job-manager.test.ts test/package.test.ts
```

Expected: `git diff --check` prints nothing. In the displayed diff, `src/status.ts` reads only `publicSummary` from progress and never reads `job.output`, `job.stderr`, `job.errorMessage`, `job.malformedEventSamples`, `job.request.task`, `job.profile.systemPrompt`, or `ProgressItem.text`.

- [ ] **Step 6: Commit the documentation**

```bash
git add README.md test/package.test.ts
git commit -m "docs: explain richer subagent status"
```
