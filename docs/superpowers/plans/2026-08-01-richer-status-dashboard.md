# Richer Status and Stable Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `subagent_status` explain bounded job activity and make `/subagents` a stable, viewport-bounded, read-only dashboard with cancellation and scrollable full details.

**Architecture:** A pure `job-status` module owns terminal-safe text normalization and projects immutable `Job` snapshots into bounded status facts. The status tool and dashboard list/compact modes use that projection; full view alone reads sanitized captured fields from the selected raw snapshot. Rendering is triggered by meaningful manager changes and user input, never elapsed wall-clock time. Registration owns one explicit, idempotent close operation for the active custom UI.

**Tech Stack:** TypeScript 5.9, Node.js 22.19 built-ins (`Buffer`, `Intl.Segmenter`), Pi extension/TUI APIs, TypeBox, Node's test runner through `tsx`.

## Global Constraints

- Preserve the existing five tools and the existing `{}` / `{ id }` `subagent_status` inputs.
- `subagent_wait` stays state-only; do not change its schema, payload, timing, or event-driven behavior.
- Complete output, partial assistant prose, stderr, errors, malformed samples, and profile prompts must not enter model-visible status text.
- Single-job status contains at most `3` independently bounded recent activity items.
- All-job status contains at most `20` jobs, ordered as active, collectable, then collected/discarded history, with stable manager order inside each group.
- Every model-visible status response remains below the existing `50 KiB` boundary.
- The dashboard shows only queued, running, completed, failed, and cancelled jobs; collected and discarded history remains outside it.
- `/subagents` supports cancellation only. It must not collect, discard, call `sendMessage()`, or inject results into the session.
- Every dashboard render returns no more than the current `tui.terminal.rows` value and every returned line is ANSI-width-bounded.
- Full view shows sanitized captured data, never raw carriage returns, cursor movement, erase commands, OSC title changes, or unrelated terminal controls.
- Remove the dashboard's one-second interval. Quiet wall-clock passage alone must request no render.
- Assistant text deltas update the retained snapshot but do not request token-rate renders. Tool phases, state, usage, diagnostics, selection, mode, scrolling, and Pi invalidation remain render-relevant.
- Dashboard cleanup closes the open custom UI, disposes the component, removes its manager subscription, clears the widget subscription and widget, and is safe more than once.
- Keep `src/output.ts` responsible for collection formatting and the `50 KiB` collected-result cap; do not move collection behavior into the new status module.
- Add no dependency, persistence, retry, steering, resume, chain, worktree, stuck detector, or timer throttle.

---

## File Structure

- Create `src/job-status.ts`: terminal-safe text primitives, `JobStatus` projection, list selection, and plain bounded formatters.
- Modify `src/job-manager.ts`: expose its injected clock as `currentTime()`.
- Modify `src/tools.ts`: use one manager-clock value and the projection for `subagent_status` and its local renderer.
- Modify `src/dashboard.ts`: read-only list, compact and full modes, viewport rendering, fingerprints, and active-dashboard teardown.
- Create `test/job-status.test.ts`: primitive, projection, privacy, ordering, byte-limit, Unicode, and terminal-control tests.
- Modify `test/tools.test.ts`: rich status, unknown-ID compatibility, privacy, and renderer tests.
- Modify `test/dashboard.test.ts`: bounded modes, cancellation, scrolling, corruption, redraw, and teardown regressions.
- Modify `README.md`: richer status example, dashboard controls, and parent-only collection/discard guidance.

## Public Interfaces

```ts
// src/job-status.ts
export interface StatusActivity {
  timestamp: number;
  kind: "assistant" | "tool" | "diagnostic";
  summary: string;
}

export interface JobStatus {
  id: string;
  state: JobState;
  task: string;
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
  usage: UsageStats;
  recentActivity: StatusActivity[];
  resultReady: boolean;
  hasError: boolean;
  captureNotices: string[];
}

export interface StatusListResult {
  statuses: JobStatus[];
  omitted: number;
}

export function sanitizeTerminalText(text: string, preserveSgr?: boolean): string;
export function boundedPreview(text: string, maxBytes?: number, maxGraphemes?: number): string;
export function projectJobStatus(job: Readonly<Job>, now: number): JobStatus;
export function selectStatusList(jobs: readonly Job[], now: number): StatusListResult;
export function formatSingleJobStatus(status: JobStatus, now: number): string;
export function formatJobStatusList(result: StatusListResult, now: number): string;

// src/job-manager.ts
currentTime(): number;

// src/tools.ts
export interface ToolDetails {
  jobs: Job[];
  statuses?: JobStatus[];
  omittedStatuses?: number;
  diagnostics: string[];
  operation?: "agents" | "start" | "status" | "wait" | "cancel" | "collect" | "discard";
}
```

`JobStatus` contains facts and bounded safe text, not ANSI styling or layout. `SubagentsDashboard` retains immutable raw snapshots only because full view needs captured diagnostics locally.

---

### Task 1: Add terminal-safe text primitives

**Files:**
- Create: `src/job-status.ts`
- Create: `test/job-status.test.ts`

**Interfaces:**
- Produces: `sanitizeTerminalText()`, `boundedPreview()`, `STATUS_ACTIVITY_LIMIT = 3`, `STATUS_JOB_LIMIT = 20`, `STATUS_PREVIEW_MAX_BYTES = 512`, and `STATUS_PREVIEW_MAX_GRAPHEMES = 160`.
- Invariant: the primitives accept arbitrary child text without producing invalid UTF-8 or non-SGR terminal controls.

- [ ] **Step 1: Write failing sanitization and Unicode-bound tests**

Create `test/job-status.test.ts` with:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { boundedPreview, sanitizeTerminalText } from "../src/job-status.js";

test("removes unsafe terminal controls while optionally retaining SGR", () => {
  const hostile = "ok\rreplace\t😀 e\u0301 漢\u001B]0;owned\u0007\u001B[2J\u001B[H\u001B[K\u001B[31mred\u001B[0m";
  const plain = sanitizeTerminalText(hostile);
  const styled = sanitizeTerminalText(hostile, true);
  assert.doesNotMatch(plain, /\r|\t|\u001B|\u0007/);
  assert.doesNotMatch(styled, /\u001B\](?:.|\n)*|\u001B\[(?:2J|H|K)/);
  assert.match(styled, /\u001B\[31mred\u001B\[0m/);
});

test("bounds previews on grapheme and UTF-8 boundaries", () => {
  const value = boundedPreview("😀".repeat(400), 511, 400);
  assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
  assert.ok(Buffer.byteLength(value, "utf8") <= 511);
  assert.equal(boundedPreview("a\tb\r\nc", 100, 100), "a b c");
});
```

- [ ] **Step 2: Verify RED**

Run `npx tsx --test test/job-status.test.ts`.

Expected: FAIL because `src/job-status.ts` does not exist.

- [ ] **Step 3: Implement the scanner and bounded preview**

Create `src/job-status.ts` with the imports, constants, and exact primitive behavior below. Import `truncateUtf8` from `./output.js`; it preserves byte boundaries after grapheme selection.

```ts
import { truncateUtf8 } from "./output.js";

export const STATUS_ACTIVITY_LIMIT = 3;
export const STATUS_JOB_LIMIT = 20;
export const STATUS_PREVIEW_MAX_BYTES = 512;
export const STATUS_PREVIEW_MAX_GRAPHEMES = 160;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeTerminalText(text: string, preserveSgr = false): string {
  let safe = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b && text[index + 1] === "]") {
      index += 2;
      while (index < text.length && text.charCodeAt(index) !== 0x07 && !(text.charCodeAt(index) === 0x1b && text[index + 1] === "\\")) index += 1;
      index += text.charCodeAt(index) === 0x1b ? 2 : 1;
      continue;
    }
    if (code === 0x1b && text[index + 1] === "[") {
      let end = index + 2;
      while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end += 1;
      const sequence = text.slice(index, Math.min(text.length, end + 1));
      const final = text[end];
      const parameters = text.slice(index + 2, end);
      if (preserveSgr && final === "m" && /^[0-9:;]*$/.test(parameters)) safe += sequence;
      index = Math.min(text.length, end + 1);
      continue;
    }
    if (code === 0x1b) { index += Math.min(2, text.length - index); continue; }
    const value = text[index] ?? "";
    if (value === "\n") safe += value;
    else if (value === "\t") safe += "   ";
    else if (value !== "\r" && code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) safe += value;
    index += 1;
  }
  return safe;
}

export function boundedPreview(text: string, maxBytes = STATUS_PREVIEW_MAX_BYTES, maxGraphemes = STATUS_PREVIEW_MAX_GRAPHEMES): string {
  const normalized = sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
  let bounded = "";
  let count = 0;
  for (const segment of graphemes.segment(normalized)) {
    if (count >= maxGraphemes) break;
    bounded += segment.segment;
    count += 1;
  }
  return truncateUtf8(bounded, maxBytes).text;
}
```

The OSC/CSI scanner must advance safely for incomplete tails; retain the `Math.min()` bounds above. Only numeric SGR sequences ending in `m` survive when `preserveSgr` is true.

- [ ] **Step 4: Verify GREEN**

Run `npx tsx --test test/job-status.test.ts`.

Expected: PASS; previews are valid UTF-8 and plain output contains no terminal escape sequence.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/job-status.ts test/job-status.test.ts
git commit -m "feat: add terminal-safe status text primitives"
```

---

### Task 2: Add `JobStatus` projection, formatters, and manager clock

**Files:**
- Modify: `src/job-status.ts`
- Modify: `src/job-manager.ts:135-142`
- Modify: `test/job-status.test.ts`
- Modify: `test/job-manager.test.ts` (the existing injected-clock test)

**Interfaces:**
- Consumes: Task 1 primitives; `Readonly<Job>`, `JobState`, `AccessMode`, `ProgressItem`, and `UsageStats` from `src/types.ts`.
- Produces: `StatusActivity`, `JobStatus`, `StatusListResult`, projection/list/formatter functions, and `JobManager.currentTime(): number`.
- Invariant: only `projectJobStatus()` reads raw progress; formatters accept projections and cannot read captured output, stderr, errors, malformed samples, or prompts.

- [ ] **Step 1: Write failing projection, ordering, and privacy tests**

Append a local `job()` fixture that has `output: "secret complete answer"`, `stderr: "secret stderr"`, `errorMessage: "secret error"`, `malformedEventSamples: ["secret malformed sample"]`, and `profile.systemPrompt: "private prompt"`. Add these tests:

```ts
test("projects queue, running, and final durations with one injected clock", () => {
  const queued = projectJobStatus(job("queued"), 6_000);
  const running = projectJobStatus(job("running"), 6_000);
  const completed = projectJobStatus(job("completed"), 10_000);
  assert.equal(queued.queueDurationMs, 5_000);
  assert.equal(queued.runDurationMs, undefined);
  assert.equal(running.queueDurationMs, 1_000);
  assert.equal(running.runDurationMs, 4_000);
  assert.equal(completed.queueDurationMs, 1_000);
  assert.equal(completed.runDurationMs, 5_000);
});

test("selects three chronological activity previews and caps grouped status", () => {
  const status = projectJobStatus(job("running", { progress: [
    { type: "tool", text: "Started read", timestamp: 2_100 },
    { type: "tool", text: "Completed read", timestamp: 2_200 },
    { type: "diagnostic", text: "Checking diagnostics in src/auth.ts", timestamp: 2_300 },
    { type: "text", text: "Reviewing the final branch", timestamp: 2_400 },
  ] }), 2_500);
  assert.deepEqual(status.recentActivity.map((item) => item.timestamp), [2_200, 2_300, 2_400]);
  assert.deepEqual(status.recentActivity.map((item) => item.kind), ["tool", "diagnostic", "assistant"]);
  for (const item of status.recentActivity) assert.ok(Buffer.byteLength(item.summary, "utf8") <= 512);
  const selected = selectStatusList(Array.from({ length: 25 }, (_, index) => job(index % 3 === 0 ? "running" : index % 3 === 1 ? "completed" : "collected", { id: `job-${index + 1}` })), 10_000);
  assert.equal(selected.statuses.length, 20);
  assert.equal(selected.omitted, 5);
  assert.deepEqual(selected.statuses.slice(0, 2).map((item) => item.state), ["running", "running"]);
});

test("formatters expose facts but exclude all captured and private fields", () => {
  const text = formatSingleJobStatus(projectJobStatus(job("failed"), 8_000), 8_000);
  assert.match(text, /job-1.*failed/);
  assert.match(text, /Result ready/);
  assert.doesNotMatch(text, /secret complete answer|secret stderr|secret error|secret malformed sample|private prompt/);
  assert.ok(Buffer.byteLength(text, "utf8") < 50 * 1024);
});
```

Also add a manager test that changes an injected `now` variable from `123` to `456` and asserts `manager.currentTime()` returns each value.

- [ ] **Step 2: Verify RED**

Run `npx tsx --test test/job-status.test.ts test/job-manager.test.ts`.

Expected: FAIL because projection, formatters, selection, and `currentTime()` are absent.

- [ ] **Step 3: Implement semantic projection and stable selection**

Add the public interfaces. Implement `clampDuration(end, start) => Math.max(0, end - start)`; queued duration ends at `now`, running duration ends at `now`, and terminal duration ends at `finishedAt`. Missing timestamps yield `undefined`; skew clamps to zero. Map `text` to assistant, recognized `Started|Updated|Completed <tool>` to a bounded tool summary (otherwise `Tool activity`), and all other nonempty progress to diagnostics. Keep the final three activities in source order.

Set `resultReady` only for completed, failed, and cancelled. Set `hasError` for failed or a captured error/stderr indicator. Copy usage with `structuredClone()`. Build capture notices only from truncation metadata, for output, stderr, error, and latest partial text; never include captured text itself. Set access to `"write"` or `"read-only"` from `request.writeAccess`. Render legacy/job/parent/default thinking source exactly as `job override`, `parent session`, `legacy profile/parent behavior`, or `model or Pi default`.

For `selectStatusList()`, stable-sort indexed snapshots into active (queued/running), collectable (completed/failed/cancelled), then history (collected/discarded), retain `STATUS_JOB_LIMIT`, and report omitted count.

- [ ] **Step 4: Implement bounded plain formatters and the clock**

`formatSingleJobStatus()` must include state/duration, task, agent/access, launch model/thinking, differing reported model, usage, up to three timestamped activities, capture notices, error indicator, and `Result ready — collect <id> to read it.` `formatJobStatusList()` must emit at most two plain lines per selected job and `<N> additional job(s) omitted.` Use seconds below a minute and `Nm Ns` thereafter; use `now` for activity age. Do not use `formatCollectedResult()` or `capCollectedPayload()`.

Add immediately after `JobManager.get()`:

```ts
currentTime(): number {
  return this.now();
}
```

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx --test test/job-status.test.ts test/job-manager.test.ts
npm run typecheck
```

Expected: PASS; a 20-job formatted list remains below 50 KiB and all duration/privacy assertions pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/job-status.ts src/job-manager.ts test/job-status.test.ts test/job-manager.test.ts
git commit -m "feat: add bounded job status projection"
```

---

### Task 3: Integrate the projection into `subagent_status`

**Files:**
- Modify: `src/tools.ts:1-86,139-148,278-310`
- Modify: `test/tools.test.ts:236-258,476-550`

**Interfaces:**
- Consumes: all Task 2 status APIs and `JobManager.currentTime()`.
- Produces: bounded model-visible content plus optional `ToolDetails.statuses` and `ToolDetails.omittedStatuses`; keeps `details.jobs` for internal renderer compatibility.
- Invariant: `statusJobs()` calls the manager clock once per response and never invokes collection formatting.

- [ ] **Step 1: Replace shallow status coverage with failing integration tests**

Replace `statusJobs lists all jobs and can inspect one job` with a completed job whose runner output is `secret final answer`. Assert one-job content includes `job-1`, completed state, task, `Agent: generic`, `Access: read-only`, launch model/thinking, usage, and `Result ready.*collect job-1`; assert it excludes `secret final answer`, `systemPrompt`, `stderr`, and `malformed`; assert `details.statuses?.length === 1`, `details.jobs.length === 1`, and byte length is below 50 KiB.

Add an all-job fake manager returning 25 indexed snapshots across running, completed, and collected states. Assert 20 statuses, 5 omitted, grouped output with `5 additional jobs omitted`, and no `secret list output`. Keep the existing unknown-ID diagnostic test unchanged. Update the renderer test so expanded status contains `Task: one`, `Recent activity:`, and `Result ready`, while compact and expanded output exclude captured output.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="statusJobs returns rich|statusJobs groups|statusJobs returns an ordinary diagnostic|tool renderers preserve" test/tools.test.ts
```

Expected: FAIL because status content and `ToolDetails.statuses` are absent.

- [ ] **Step 3: Implement status details and one-clock execution**

Import `formatJobStatusList`, `formatSingleJobStatus`, `projectJobStatus`, `selectStatusList`, and `type JobStatus` from `./job-status.js`. Extend `ToolDetails` with the public optional fields. At the start of `statusJobs()`, assign `const now = services.manager.currentTime()`.

For `{ id }`, return the unchanged `Unknown job: <id>` diagnostic when absent; otherwise project one snapshot and return `formatSingleJobStatus(status, now)` with `{ jobs: [job], statuses: [status], diagnostics: [], operation: "status" }`. For `{}`, call `selectStatusList(services.manager.list(), now)` and return `formatJobStatusList(selected, now)` with all raw jobs, selected statuses, omitted count, empty diagnostics, and operation. Do not pass either string through `formatCollectedResult()` or `capCollectedPayload()`.

- [ ] **Step 4: Make the local tool renderer consume status facts**

Handle `operation === "status" && statuses` before generic launch detail. Its compact text is `Jobs: <count> (+<omitted> omitted)` followed by `<icon> <id> <state>` per status and diagnostics; expanded text appends the already-bounded `content`. Remove status from the `launchDetail()` branch. Keep start rendering unchanged.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="statusJobs|tool renderers preserve" test/tools.test.ts
npm run typecheck
```

Expected: PASS; unknown IDs remain compatible and status content never leaks captured fields.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: enrich subagent status output"
```

---

### Task 4: Build bounded cancellation-only list mode and remove the timer

**Files:**
- Modify: `src/dashboard.ts:1-240`
- Modify: `test/dashboard.test.ts:1-470`

**Interfaces:**
- Consumes: `projectJobStatus()`, `boundedPreview()`, `JobManager.list()`, `JobManager.cancel(id)`, and `terminalRows(): number`.
- Produces: list mode with a current-row budget, cancellation-only controls, and no periodic work.
- Invariant: list mode never reads captured fields and never renders queued/running/completed/failed/cancelled history outside the dashboard filter.

- [ ] **Step 1: Make the test fixture expose a row budget and clock**

Delete `ManualTimer`. Add `rows = 24` to `FakeUi`; in `custom()`, pass `terminal: { get rows() { return thisOwner.rows; } }` using a closed-over `const thisOwner = this`. Pass `terminalRows: () => pi.ui.rows` in the direct `dashboard()` helper. Add `currentTime(): number { return 10_000; }` to `FakeManager`.

- [ ] **Step 2: Replace timer/collection tests with failing list and cancellation tests**

Delete dashboard collect/discard/retry/delivery tests, `x`/`d` eligibility tests, interval creation/ticking/clearing tests, and the `simple-subagents-result` dashboard renderer test if no non-dashboard code uses it. Add a 30-job test at 24, 60, and 100 columns asserting `view.render(width).length <= 12` and every `visibleWidth(line) <= width`. Add a cancellation test that sends `x` and `d`, asserts no manager calls or Pi messages and no `x collect|d discard` footer text, then sends `c` on a running job and asserts only `cancel:job-2`.

- [ ] **Step 3: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="list mode never exceeds|cancellation but no collection" test/dashboard.test.ts
```

Expected: FAIL because timer/list actions and unbounded rendering still exist.

- [ ] **Step 4: Implement list state, cancellation-only input, and viewport slicing**

Remove `formatCollectedResult`, dashboard `ExtensionAPI pi` option, all `setInterval`/`clearInterval` fields and helpers, collect/discard branches, and the dashboard `simple-subagents-result` message renderer. Remove its now-unused Markdown imports; retain `ExtensionAPI` for registration.

Set mode to `"list"`; add `listOffset`, `cachedWidth`, `cachedRows`, `cachedLines`, and `disposed`. Add `terminalRows(): number` and `now?: () => number` options; default `now` to `options.manager.currentTime()`. `handleInput()` supports Up/Down selection, Escape disposal/close, and `c` only when the selected visible job is queued or running. Cancellation calls `manager.cancel(id)` and on rejection calls `notify("Could not cancel subagent job.")` then refreshes snapshots. `x` and `d` are no-ops.

Build grouped `QUEUED`, `RUNNING`, and `INBOX` records using projected facts. A row includes marker, ID, write marker, state/duration, task, and latest activity only when width permits; finish every line with `truncateToWidth()`. Reserve one title and one footer row (`↑↓ select · c cancel · esc close`), clamp `listOffset` to keep the selected record in `Math.max(0, rows - 2)` body rows, and slice the body. Cache against both width and current terminal rows. Do not advertise or activate Enter/`v` until Tasks 5 and 6 add those modes.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="list mode never exceeds|cancellation but no collection|dashboard" test/dashboard.test.ts
npm run typecheck
```

Expected: PASS; no list frame exceeds width/rows, and dashboard controls only cancel.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "refactor: bound dashboard list and remove timer actions"
```

---

### Task 5: Add compact detail mode and selection reconciliation

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 4 list state and Task 2 `JobStatus` facts.
- Produces: `"list" | "compact"` mode state, bounded compact details, and identity-preserving `setJobs()`.
- Invariant: compact mode reads only `JobStatus`; external parent collection/discard may hide a selection but cannot leave the dashboard pointing at the wrong job.

- [ ] **Step 1: Write failing compact and reconciliation tests**

Add a failed-job compact test with secret output, stderr, error, and malformed sample. Press Enter and assert `Task:`, `Agent:`, `Access:`, `Launch model:`, `Reported model:`, `Created:`, `Queue:`, `Run:`, `Usage:`, and `Recent activity:`; assert all secret strings are absent and all lines fit 120 columns/row budget. Assert the footer now advertises `enter inspect` but does not advertise `v full`. Add a test that selects `job-2`, replaces snapshots while retaining it, and asserts selection remains `job-2`; then removes it and asserts list/compact mode selects the nearest remaining visible job. Do not enter full mode in this task; Task 6 introduces it.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="compact details use shared|preserves selected identity" test/dashboard.test.ts
```

Expected: FAIL because compact mode and identity reconciliation are absent.

- [ ] **Step 3: Implement compact mode and bounded detail records**

Define `type DashboardMode = "list" | "compact"`. Enter toggles list/compact for a selected job. Compact mode renders the selected projected row plus one-line fields for task, agent/access, launch/reported model, ISO created/started/finished timestamps, queue/run duration, usage, latest three activities or `No activity reported yet`, and capture/error indicators. Use `wrapTextWithAnsi()` only for Task and Recent activity. Slice to the body budget and append `… N compact lines omitted` as the final body line when clipped; truncate every final line to width. Add `enter inspect` to list/compact help, but leave `v` inactive and unadvertised until Task 6 supplies a complete full view.

- [ ] **Step 4: Reconcile snapshots by selected identity**

In `setJobs(jobs)`, remember the previous selected ID/index, always store latest snapshots, locate that ID among `visibleJobs()`, and retain its index when present. Otherwise select `Math.min(priorIndex, Math.max(0, visible.length - 1))`. Invalidate and request render after this state change; Task 8 narrows that request with a fingerprint without changing this behavior. Task 6 extends this same reconciliation so a full-mode selection removed by external collection/discard returns to list and resets `fullOffset`.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="compact details use shared|preserves selected identity|dashboard" test/dashboard.test.ts
npm run typecheck
```

Expected: PASS; compact details expose bounded facts only and selection is stable across updates.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "feat: add compact dashboard details"
```

---

### Task 6: Add full-view frame, navigation, and viewport

**Files:**
- Modify: `src/dashboard.ts` (full-mode rendering and input)
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 5 mode/selection state, `Key.up`, `Key.down`, `Key.pageUp`, `Key.pageDown`, `Key.home`, `Key.end`, and `wrapTextWithAnsi()`.
- Produces: `DashboardMode = "list" | "compact" | "full"`, a full-mode metadata frame with a clamped line viewport, `v full` help, and return navigation.
- Invariant: this task renders status metadata only; Task 7 is the first task that adds raw captured output, stderr, errors, malformed samples, and progress text.

- [ ] **Step 1: Write failing metadata-frame and navigation tests**

Set `pi.ui.rows = 10`, open full view for a completed job, and assert at most 10 lines, title `Subagent job-1 · full view`, footer `lines 1–8 of`, and no raw `output`, `stderr`, `error`, malformed sample, or progress text. PageDown must change the footer start; End then Home must produce the last and first windows. Add Escape and `v` tests asserting they return to the prior compact/list mode without calling dashboard `done()`. While full mode is open, remove the selected job through `setJobs()` and assert mode returns to list with `fullOffset === 0` and the nearest visible selection.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="full metadata viewport|full navigation returns" test/dashboard.test.ts
```

Expected: FAIL because full mode has no frame, navigation, or viewport.

- [ ] **Step 3: Implement metadata line assembly and full input**

Extend `DashboardMode` to `"list" | "compact" | "full"`, add `ReturnMode`, `fullReturnMode`, and `fullOffset`, then wire `v` from list/compact to record the return mode and open full view. Add `v full` to list/compact help only now that the target mode is complete.

Create `fullMetadata(status, width): string[]` from every compact semantic field, including timestamps, queue/run duration, usage, activities, and capture notices; use labels and width wrapping, then `truncateToWidth()` each line. It must not access raw `Job` text. `handleFullInput()` moves one line for Up/Down, `Math.max(1, rows - 2)` lines for PageUp/PageDown, zero for Home, and `Number.MAX_SAFE_INTEGER` for End; `v` or Escape restores `fullReturnMode` and resets offset. Every accepted input calls `changed()`.

- [ ] **Step 4: Render the full frame and clamp its viewport**

Use title plus footer as two reserved rows. Clamp offset to `0..Math.max(0, content.length - bodyRows)` on every render, slice content, and emit `lines <start>–<end> of <total> · ↑↓ line · PgUp/PgDn page · Home/End · v/esc back`. When reconciliation finds a missing selected job in full mode, switch to list and reset `fullOffset = 0`. When `rows === 1`, return only the title; when `rows === 2`, return title and footer. Include rows in the cache key so resize recomputes and reclamps.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="full metadata viewport|full navigation returns|width" test/dashboard.test.ts
npm run typecheck
```

Expected: PASS; full metadata is viewport-bounded and navigation never closes the dashboard.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "feat: add dashboard full-view navigation"
```

---

### Task 7: Add sanitized captured full-detail content and corruption regressions

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 6 full metadata frame, selected raw `Job`, `sanitizeTerminalText(text, true)`, and `wrapTextWithAnsi()`.
- Produces: sanitized Output, Stderr, Error, Malformed, and Progress sections appended to full detail.
- Invariant: raw child text is sanitized before line splitting/wrapping, and every returned line remains width-bounded.

- [ ] **Step 1: Write failing captured-content and corruption regressions**

Add a 1,400-line output test at 10 rows; entering full view must show a bounded viewport and page navigation must reveal later output. Add one hostile fixture to output, stderr, error, malformed samples, and text progress:

```ts
const hostile = "before\rafter\t😀 e\u0301 漢\n"
  + "\u001B]0;owned title\u0007"
  + "\u001B[2Jclear\u001B[Hhome\u001B[Kerase"
  + "\u001B[31mred\u001B[0m";
```

At width 36 and 14 rows assert all sections can be reached through scrolling, every line fits, rendered text contains no `\r`, `\t`, OSC, `2J`, `H`, or `K`, and at least one of `😀`, `漢`, or `é` remains visible. Add resize/content-shrink coverage: scroll to End, replace output with `short`, increase rows, call `setJobs()`, and assert `lines 1–<n> of <n>` and `short`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="maximum captured output|strips cursor controls|content shrink" test/dashboard.test.ts
```

Expected: FAIL because full view still omits captured fields.

- [ ] **Step 3: Append sanitized captured sections to full detail**

Replace metadata-only content with `fullDetail(job, status, width)`. First include the Task 6 metadata. Then append `Output`, `Stderr`, `Error`, `Malformed`, and `Progress`; use `No captured output.`, `No stderr captured.`, `No error reported.`, `No malformed protocol samples.`, and `No activity reported yet.` when empty. Include malformed event count even without samples; preserve truncation notices from `status.captureNotices`.

For each label/value, call `sanitizeTerminalText(value, true)` before splitting on newline. Wrap each segment to `Math.max(1, width - label.length)`, prefix continuation lines with spaces matching the label, then pass each final line through `truncateToWidth()`. Progress values are `<ISO timestamp> <type>: <item.text>` before sanitization. Do not sanitize after ANSI width wrapping.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="maximum captured output|strips cursor controls|content shrink|full" test/dashboard.test.ts
npm run typecheck
```

Expected: PASS; raw captured content is locally readable only in full view and cannot control the terminal.

- [ ] **Step 5: Commit Task 7**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "feat: show sanitized dashboard full details"
```

---

### Task 8: Suppress token-delta redraws with a render fingerprint

**Files:**
- Modify: `src/dashboard.ts`
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: Task 5 `setJobs()` reconciliation and manager snapshot subscriptions.
- Produces: a raw-snapshot fingerprint that ignores only assistant-text content/timestamps while retaining newest snapshots.
- Invariant: text deltas do not request a render; tool phases, state, usage, diagnostics, selection/mode/scroll, and Pi invalidation do.

- [ ] **Step 1: Write failing redraw tests**

Add `constructing a running dashboard creates no refresh interval` by replacing `globalThis.setInterval`, constructing a running view, and asserting zero calls. Add `assistant deltas retain the latest snapshot without token-rate renders`: set a running job's text progress from `a` to `ab` to `abc latest`, assert render requests do not increase, enter compact mode, and assert `abc latest` appears. Add changes for tool progress, usage, and completed state, each asserting exactly one new render request.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="no refresh interval|assistant deltas|tool phases" test/dashboard.test.ts
```

Expected: FAIL because `setJobs()` invalidates for every snapshot update.

- [ ] **Step 3: Implement the fingerprint and conditional invalidation**

Import `Buffer`. Add `textFingerprint(text)` using FNV-1a (`2_166_136_261`, XOR each UTF-16 code unit, `Math.imul(hash, 16_777_619)`) and return `<UTF-8 byte length>:<unsigned hash>`. Serialize each job's id, state, task, profile name, write access, lifecycle timestamps, launch/reported model/thinking, usage, non-text progress, whether text exists, output/stderr/error fingerprints, all truncation metadata, malformed count, and malformed samples. Exclude only in-progress assistant text payload and timestamp.

Store the initial fingerprint. In `setJobs()`, compute next fingerprint, always retain snapshots and apply Task 5 reconciliation, then call `changed()` only if fingerprint changed or reconciliation changed selected identity/mode. Do not recreate an interval. `invalidate()`, `changed()`, `setJobs()`, `handleInput()`, cancellation rejection, and `dispose()` must no-op after disposal; invalidation clears every cache key.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="no refresh interval|assistant deltas|tool phases|dashboard" test/dashboard.test.ts
npm run typecheck
```

Expected: PASS; new text is retained for a later user render, but only render-relevant changes request redraw.

- [ ] **Step 5: Commit Task 8**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "fix: suppress dashboard token-delta redraws"
```

---

### Task 9: Make registration and session lifecycle cleanup idempotent

**Files:**
- Modify: `src/dashboard.ts` (`registerSubagentsUi()`)
- Modify: `src/index.ts:46-64` only if an assertion needs an explicit lifecycle ordering guard
- Modify: `test/dashboard.test.ts`

**Interfaces:**
- Consumes: custom UI `done()`, component `dispose()`, manager/widget subscriptions, and session lifecycle handlers.
- Produces: one idempotent registration cleanup that closes an unresolved active dashboard before clearing widget resources.
- Invariant: stale callbacks and repeated cleanup cannot request a render; `src/index.ts` preserves `removeSubagentsUi(); manager.shutdown()` ordering.

- [ ] **Step 1: Write failing stale-callback and lifecycle tests**

Make `FakeManager.subscribe()` retain a captured listener after unsubscribe. Register the UI, open `/subagents`, capture the listener, close with Escape, invoke stale with a completed snapshot, and assert render count does not change. Add a cleanup test that opens unresolved `ctx.ui.custom()`, invokes returned cleanup twice, awaits opening, and asserts one `done()`, zero manager listeners, cleared widget, and no render after a manager update. Add a replacement-session test that emits `session_start` twice and asserts the old custom UI closes before the replacement widget subscription is installed.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="captured manager callback|registration cleanup|replacement session" test/dashboard.test.ts
```

Expected: FAIL because registration cleanup currently owns only widget state.

- [ ] **Step 3: Implement one active-dashboard close path**

In `registerSubagentsUi()`, add `let activeDashboard: { close(): void } | undefined` and `let cleanedUp = false`. Before opening a command UI, close the prior active dashboard. Give each opening an idempotent `close()` that owns, in this order: component `dispose()`, manager `unsubscribe()`, clearing `activeDashboard` only when it is that instance, and custom `done()`. `requestRender` and notification closures must check the local closed flag. After `ctx.ui.custom()` resolves, call its active close as a safe finalizer.

At the beginning of the existing `session_start` UI handler, close/clear the active dashboard before `clearWidget()` installs the replacement widget. Return cleanup that guards `cleanedUp`, closes and clears the active dashboard, then calls `clearWidget()`. Keep `src/index.ts` shutdown ordering unchanged; modify it only if needed to make that order explicit and testable.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="captured manager callback|registration cleanup|replacement session|extension clears" test/dashboard.test.ts
npm run typecheck
```

Expected: PASS; each resource closes once and no stale callback reaches `tui.requestRender()`.

- [ ] **Step 5: Commit Task 9**

```bash
git add src/dashboard.ts src/index.ts test/dashboard.test.ts
git commit -m "fix: clean up active dashboard sessions"
```

---

### Task 10: Document richer status and dashboard controls

**Files:**
- Modify: `README.md:24-30,58-84`

**Interfaces:**
- Consumes: final tool output and dashboard controls.
- Produces: user documentation that describes bounded status and never advertises dashboard collection/discard.

- [ ] **Step 1: Write a failing documentation-content check**

Run:

```bash
rg -n "read-only inspection dashboard|subagent_status reports bounded|dashboard never injects" README.md
```

Expected: no matches before this task.

- [ ] **Step 2: Update usage and add the exact bounded-status example**

Replace the `/subagents` usage sentence with:

```md
Ask Pi naturally: “start three parallel subagents to review the tests, dependencies, and docs”; “show subagent status”; “wait for job-1 and job-3”; “cancel job-2”; or “collect job-1 and job-3.” `/subagents` opens a read-only inspection dashboard: arrows select jobs, Enter toggles compact details, `v` opens or closes the scrollable full view, Page Up/Page Down and Home/End scroll full details, `c` cancels queued or running work, and Escape returns from full view or closes the dashboard.
```

Add this text and example immediately after it:

````md
`subagent_status` reports bounded task, state, timing, profile, access, launch/reported model, usage, and up to three recent activity previews. It never returns the complete captured answer, stderr, error body, malformed protocol samples, or profile prompt. A completed status points the parent to `subagent_control` to collect the result.

```text
job-2 — running · running for 2m 14s
Task: Review authentication changes
Agent: reviewer · Access: read-only
Model: openai-codex/gpt-5.6-terra · Thinking: medium (job override)
Usage: 28000 input · 3000 output · 6 turns · $0.08
Recent activity:
  4s ago   Completed read
  2s ago   Started lsp_diagnostics
  now      Checking diagnostics in src/auth.ts
```
````

- [ ] **Step 3: Clarify parent-only collection and lifecycle**

Replace the lifecycle sentence that says the dashboard can cancel/collect/discard with:

```md
At most four jobs run at once, and a start or control batch accepts at most eight jobs. Collected output is capped at 50 KB. Cancel queued or running work from the tools or dashboard. Collection and discard are parent-agent operations through `subagent_control`; the dashboard never injects a result into the conversation. Session shutdown cancels queued and active jobs before the extension closes.
```

Keep the existing memory-only warning and wait guidance.

- [ ] **Step 4: Verify GREEN documentation and ownership boundaries**

Run:

```bash
rg -n "read-only inspection dashboard|subagent_status reports bounded|dashboard never injects" README.md
rg -n "x collect|d discard|sendMessage\(|formatCollectedResult|setInterval|clearInterval" src/dashboard.ts test/dashboard.test.ts README.md
rg -n "formatCollectedResult|COLLECTED_OUTPUT_MAX_BYTES|capCollectedPayload" src/output.ts src/tools.ts src/dashboard.ts
```

Expected: the first command finds all three new statements; the second finds no dashboard collection/message/timer matches (README may use explanatory `collection` or `discard` words but no dashboard bindings); the third finds collection formatting/capping only in `src/output.ts` and `src/tools.ts`, never `src/dashboard.ts`.

- [ ] **Step 5: Commit Task 10**

```bash
git add README.md
git commit -m "docs: explain richer status dashboard"
```

---

## Final Verification Checklist

Run these only after all ten task commits; this is a release gate, not an implementation task.

- [ ] Run proactive language-server diagnostics on `src/job-status.ts`, `src/job-manager.ts`, `src/tools.ts`, `src/dashboard.ts`, `src/index.ts`, `test/job-status.test.ts`, `test/tools.test.ts`, and `test/dashboard.test.ts`. Expected: no TypeScript errors.
- [ ] Run `npm test`, `npm run typecheck`, and `git diff --check` from fresh output. Expected: all pass with no whitespace errors.
- [ ] Confirm `subagent_status({ id })` explains task, state, timing, model, usage, and recent activity without complete captured content, and `subagent_status({})` returns at most 20 two-line entries plus a stable grouped omitted count.
- [ ] Confirm status and dashboard list/compact use the same `JobStatus` projection; list, compact, and full return no more than `tui.terminal.rows` lines; full offsets clamp after scrolling, resize, content shrink, and external collection/discard.
- [ ] Confirm dashboard has cancellation only: `x`, `d`, `sendMessage()`, result collection, intervals, and elapsed-time refreshes are absent; assistant text retains snapshots without redraw while tool/state/usage changes redraw.
- [ ] Confirm repeated cleanup and captured stale callbacks are no-ops, and child-controlled cursor, erase, carriage-return, OSC, and non-SGR controls cannot reach dashboard output.
- [ ] When an interactive terminal is available, run Pi with `PI_TUI_WRITE_LOG`, start a job emitting tool progress and multiline output, exercise list/compact/full, line/page/Home/End scrolling, narrow/wide and short/tall resize, cancellation, close/reopen, `/reload`, and exit with the dashboard open. Inspect the log for duplicate `Working...` rows, drift, stale redraws, unsafe controls, and oversized frames. If no interactive terminal is available, record this smoke test as not run.
