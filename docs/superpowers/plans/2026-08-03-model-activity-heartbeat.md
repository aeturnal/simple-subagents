# Model Activity Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show safe, bounded model-turn and reasoning activity in every subagent status surface without retaining reasoning text.

**Architecture:** Extend the existing `ProgressItem` pipeline with one replaceable `model` activity record. `PiProcessRunner` translates documented Pi turn/reasoning events into fixed labels and throttles continuing reasoning heartbeats to one per five seconds; `JobManager` coalesces that activity; the shared status projection supplies it to `subagent_status`, `/subagents`, and the live widget.

**Tech Stack:** TypeScript 5.9, Node.js 22.19 built-ins, Pi JSON event protocol, Pi extension/TUI APIs, Node test runner through `tsx`.

## Global Constraints

- Never retain or display reasoning text, partial reasoning, provider metadata, or raw model event payloads.
- Public model activity labels are exactly `Model turn started`, `Model reasoning`, `Model reasoning finished`, and `Model turn finished`.
- Accept continuing `thinking_delta` activity at most once per 5,000 ms, measured from the previous accepted reasoning activity.
- Keep at most one `model` progress record per job and keep it chronologically ordered as the latest accepted model activity.
- Keep the existing maximum of 200 tool/diagnostic history records independently of the replaceable model and partial-answer records.
- Add no interval, timeout, dependency, configuration field, structured current-phase field, stall detector, execution deadline, or lifecycle change.
- Preserve existing tool, partial-answer, process settlement, cancellation, wait, collection, and discard behavior.
- Use documented Pi JSON event shapes and fake child processes; do not make a paid provider call.
- Implement against approved design `docs/superpowers/specs/2026-08-03-model-activity-heartbeat-design.md` at commit `67cd8d5`.

## File Structure

- Modify `src/types.ts` to add the `model` progress-item type.
- Modify `src/process-runner.ts` to recognize turn/reasoning events, use an injected clock, publish fixed labels, and throttle reasoning activity.
- Modify `src/job-manager.ts` to coalesce model activity separately from bounded tool/diagnostic history and partial answer text.
- Modify `src/job-status.ts` to project model activity with a distinct safe kind.
- Modify `test/process-runner.test.ts` for protocol reduction, throttle boundaries, privacy, malformed input, and split JSON.
- Modify `test/job-manager.test.ts` for model coalescing, ordering, and independent history bounds.
- Modify `test/job-status.test.ts` for shared model-activity projection.
- Modify `test/tools.test.ts` to prove `subagent_status` renders the activity.
- Modify `test/dashboard.test.ts` to prove `/subagents` renders the activity.
- Modify `test/live-widget.test.ts` to prove the live widget renders the activity.
- Modify `README.md` to document safe model activity and its provider-event dependency.

---

### Task 1: Capture safe, throttled model activity

**Files:**

- Modify: `src/types.ts:47-52`
- Modify: `src/process-runner.ts:65-70,116-261`
- Test: `test/process-runner.test.ts:20-55,280-405`

**Interfaces:**

- Consumes: Pi top-level events with `type: "turn_start" | "turn_end"` and `message_update` events whose assistant message event has `type: "thinking_start" | "thinking_delta" | "thinking_end"`.
- Produces: `ProgressItem.type` includes `"model"`.
- Produces: `PiProcessRunnerDependencies.now?: () => number` with production default `Date.now`.
- Produces: fixed `model` progress records for later `JobManager` retention.

- [ ] **Step 1: Add a failing process-runner test for turn and reasoning activity**

Near the existing text-delta reduction tests in `test/process-runner.test.ts`, add a deterministic fake-clock test. Construct the runner directly so the fake child and injected clock are both visible:

```ts
test("emits fixed turn and throttled reasoning activity without exposing reasoning text", async () => {
  const child = new FakeChildProcess();
  const progress: ProgressItem[] = [];
  let now = 1_000;
  const runner = new PiProcessRunner({
    now: () => now,
    spawnProcess: () => child,
  });
  const running = runner.run(runOptions({ onProgress: (item) => progress.push(item) }));
  const emit = (event: unknown): void => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  };

  emit({ type: "turn_start" });
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_start", content: "SECRET_START" },
  });
  now = 5_999;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "SECRET_EARLY" },
  });
  now = 6_000;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "SECRET_BOUNDARY" },
  });
  now = 6_001;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_end", content: "SECRET_END" },
  });
  emit({ type: "turn_end" });

  assert.deepEqual(
    progress.map(({ type, text, timestamp }) => [type, text, timestamp]),
    [
      ["model", "Model turn started", 1_000],
      ["model", "Model reasoning", 1_000],
      ["model", "Model reasoning", 6_000],
      ["model", "Model reasoning finished", 6_001],
      ["model", "Model turn finished", 6_001],
    ],
  );
  assert.doesNotMatch(JSON.stringify(progress), /SECRET_/u);

  child.close();
  await running.result;
});
```

This one test proves the exact 5,000 ms boundary, an ignored early delta, unconditional reasoning completion, fixed labels, deterministic timestamps, and privacy.

- [ ] **Step 2: Add failing tests for split input, defensive shapes, and turn reset**

Add a second test that splits a `thinking_start` JSON line across chunks, sends malformed-but-parseable nested shapes, then proves a new turn resets the throttle:

```ts
test("handles split reasoning events and resets heartbeat state at turn boundaries", async () => {
  const child = new FakeChildProcess();
  const progress: ProgressItem[] = [];
  let now = 10_000;
  const runner = new PiProcessRunner({
    now: () => now,
    spawnProcess: () => child,
  });
  const running = runner.run(runOptions({ onProgress: (item) => progress.push(item) }));

  const start = JSON.stringify({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_start", content: "PRIVATE" },
  });
  child.stdout.emit("data", Buffer.from(start.slice(0, 30)));
  child.stdout.emit("data", Buffer.from(`${start.slice(30)}\n`));
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", message: null, assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE" } })}\n`));
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", message: { role: "user" }, assistantMessageEvent: { type: "thinking_end", content: "PRIVATE" } })}\n`));
  child.stdout.emit("data", Buffer.from('{"type":"turn_end"}\n{"type":"turn_start"}\n'));
  now = 10_001;
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_AFTER_RESET" },
  })}\n`));

  assert.deepEqual(progress.map((item) => item.text), [
    "Model reasoning",
    "Model turn finished",
    "Model turn started",
    "Model reasoning",
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE/u);

  child.close();
  await running.result;
});
```

The unsupported message roles and absent message record must produce no model activity and must not throw.

- [ ] **Step 3: Run the focused tests to verify RED**

Run:

```sh
npx tsx --test --test-name-pattern="emits fixed turn|handles split reasoning" test/process-runner.test.ts
```

Expected: FAIL because `PiProcessRunnerDependencies` has no `now` property and the runner emits no `model` progress records. If `tsx` strips the type error, the activity assertions must still fail.

- [ ] **Step 4: Extend the progress and runner dependency types**

In `src/types.ts`, make the union exact:

```ts
export interface ProgressItem {
  type: "text" | "tool" | "diagnostic" | "model";
  text: string;
  timestamp: number;
  truncation?: TextTruncation;
}
```

In `src/process-runner.ts`, extend the dependency interface and class:

```ts
export interface PiProcessRunnerDependencies {
  spawnProcess?(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess;
  setTimer?(callback: () => void, delay: number): unknown;
  clearTimer?(timer: unknown): void;
  fileExists?(path: string): boolean;
  now?(): number;
}
```

```ts
private readonly now: () => number;
```

In the constructor:

```ts
this.now = dependencies.now ?? Date.now;
```

Change the existing tool and partial-answer timestamp expressions from `Date.now()` to `this.now()` so all progress emitted by one runner uses the same injected clock. Do not change timestamp meaning or add a timer.

- [ ] **Step 5: Add fixed model activity reduction and heartbeat throttling**

Inside `PiProcessRunner.run`, add private per-run state and an emitter next to the existing progress emitters:

```ts
let lastReasoningActivityAt: number | undefined;

const emitModelProgress = (text: string, timestamp = this.now()): number => {
  options.onProgress({ type: "model", text, timestamp });
  return timestamp;
};
```

At the start of `reduceEvent`, after confirming the event is a record and before message handling, add turn boundaries:

```ts
if (record.type === "turn_start") {
  lastReasoningActivityAt = undefined;
  emitModelProgress("Model turn started");
  return;
}

if (record.type === "turn_end") {
  lastReasoningActivityAt = undefined;
  emitModelProgress("Model turn finished");
  return;
}
```

Replace the current `message_update` branch with the same text-delta behavior plus these reasoning cases. Require `message?.role === "assistant"` before handling any nested assistant event:

```ts
if (record.type === "message_update") {
  const message = asRecord(record.message);
  const assistantEvent = asRecord(record.assistantMessageEvent);
  if (message?.role !== "assistant" || !assistantEvent) return;

  if (assistantEvent.type === "thinking_start") {
    lastReasoningActivityAt = emitModelProgress("Model reasoning");
    return;
  }

  if (assistantEvent.type === "thinking_delta") {
    const timestamp = this.now();
    if (lastReasoningActivityAt === undefined || timestamp - lastReasoningActivityAt >= 5_000) {
      lastReasoningActivityAt = emitModelProgress("Model reasoning", timestamp);
    }
    return;
  }

  if (assistantEvent.type === "thinking_end") {
    emitModelProgress("Model reasoning finished");
    lastReasoningActivityAt = undefined;
    return;
  }

  if (assistantEvent.type === "text_delta") {
    const delta = asString(assistantEvent.delta);
    if (delta !== undefined) {
      partialOriginalBytes += Buffer.byteLength(delta, "utf8");
      if (!partialCaptureExhausted) {
        const captured = truncateUtf8(partialOutput + delta, CAPTURED_TEXT_MAX_BYTES);
        partialOutput = captured.text;
        partialCaptureExhausted = captured.truncation !== undefined;
      }
      emitPartial();
    }
  }
  return;
}
```

Do not inspect `content`, `delta`, or any other reasoning payload field. Do not emit a diagnostic for unknown assistant events.

- [ ] **Step 6: Run the focused runner tests to verify GREEN**

Run:

```sh
npx tsx --test --test-name-pattern="emits fixed turn|handles split reasoning" test/process-runner.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the complete runner suite and typecheck**

Run:

```sh
npx tsx --test test/process-runner.test.ts
npm run typecheck
```

Expected: all process-runner tests pass and TypeScript reports no errors. In particular, existing tool and partial-text event tests remain unchanged apart from using the injected production-equivalent clock.

- [ ] **Step 8: Commit the capture boundary**

```sh
git add src/types.ts src/process-runner.ts test/process-runner.test.ts
git commit -m "feat: expose safe model activity"
```

---

### Task 2: Coalesce model activity in the job manager

**Files:**

- Modify: `src/job-manager.ts:410-429`
- Test: `test/job-manager.test.ts:499-531`

**Interfaces:**

- Consumes: `ProgressItem` with `type: "model"` and one of the four fixed labels from Task 1.
- Produces: one retained model activity per job, independent of the 200-item tool/diagnostic history and one retained partial-answer record.
- Produces: chronologically ordered progress consumed by the shared status projection in Task 3.

- [ ] **Step 1: Add failing manager tests for replacement, ordering, and independent bounds**

Near the existing progress-retention tests in `test/job-manager.test.ts`, add:

```ts
test("retains one latest model activity without consuming tool and diagnostic history", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  for (let index = 0; index < 199; index += 1) {
    runner.progress(0, { type: "tool", text: `event ${index}`, timestamp: index });
  }
  runner.progress(0, { type: "diagnostic", text: "diagnostic", timestamp: 199 });
  runner.progress(0, { type: "model", text: "Model turn started", timestamp: 200 });
  runner.progress(0, { type: "text", text: "partial answer", timestamp: 201 });
  runner.progress(0, { type: "model", text: "Model reasoning", timestamp: 202 });

  const progress = manager.get(job.id)?.progress ?? [];
  assert.equal(progress.filter((item) => item.type === "tool" || item.type === "diagnostic").length, 200);
  assert.deepEqual(progress.filter((item) => item.type === "model"), [
    { type: "model", text: "Model reasoning", timestamp: 202 },
  ]);
  assert.deepEqual(progress.filter((item) => item.type === "text"), [
    { type: "text", text: "partial answer", timestamp: 201, truncation: undefined },
  ]);
  assert.equal(progress.at(-1)?.type, "model");
});
```

Add a boundary assertion to the existing 201-tool test after a model record is present, proving a 201st tool still evicts the oldest tool rather than the model record:

```ts
runner.progress(0, { type: "model", text: "Model reasoning", timestamp: 202 });
const retained = manager.get(job.id)?.progress ?? [];
assert.equal(retained.filter((item) => item.type === "tool").length, 200);
assert.equal(retained.filter((item) => item.type === "model").length, 1);
```

- [ ] **Step 2: Run the focused manager test to verify RED**

Run:

```sh
npx tsx --test --test-name-pattern="latest model activity|newest 200 progress" test/job-manager.test.ts
```

Expected: FAIL because model records accumulate and count against the existing non-text limit.

- [ ] **Step 3: Coalesce model activity independently in `JobManager`**

Refactor `JobManager.addProgress` into three explicit branches while preserving the existing text truncation block:

```ts
if (item.type === "text") {
  const captured = truncateUtf8(item.text, CAPTURED_TEXT_MAX_BYTES);
  const originalBytes = item.truncation?.originalBytes ?? Buffer.byteLength(item.text, "utf8");
  const keptBytes = Buffer.byteLength(captured.text, "utf8");
  const truncation = originalBytes > keptBytes ? { originalBytes, keptBytes } : undefined;
  entry.job.progress = entry.job.progress.filter((progress) => progress.type !== "text");
  if (captured.text) entry.job.progress.push(structuredClone({ ...item, text: captured.text, truncation }));
} else if (item.type === "model") {
  entry.job.progress = entry.job.progress.filter((progress) => progress.type !== "model");
  entry.job.progress.push(structuredClone(item));
} else {
  entry.job.progress.push(structuredClone(item));
  const historyOverflow = entry.job.progress.filter(
    (progress) => progress.type !== "text" && progress.type !== "model",
  ).length - MAX_PROGRESS_ITEMS;
  if (historyOverflow > 0) {
    let remaining = historyOverflow;
    entry.job.progress = entry.job.progress.filter(
      (progress) => progress.type === "text" || progress.type === "model" || remaining-- <= 0,
    );
  }
}
this.notify();
```

Do not add a second manager field, timer, or notification path. An accepted model update produces exactly one normal manager notification.

- [ ] **Step 4: Run the complete manager suite and typecheck**

Run:

```sh
npx tsx --test test/job-manager.test.ts
npm run typecheck
```

Expected: all manager tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit bounded model retention**

```sh
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: retain latest model activity"
```

---

### Task 3: Project and display model activity everywhere

**Files:**

- Modify: `src/job-status.ts:53-57,98-120`
- Test: `test/job-status.test.ts:60-75`
- Test: `test/tools.test.ts:520-560`
- Test: `test/dashboard.test.ts:190-230`
- Test: `test/live-widget.test.ts:35-70`
- Modify: `README.md:28-45`

**Interfaces:**

- Consumes: chronologically ordered, coalesced `model` progress from Task 2.
- Produces: `StatusActivity.kind` includes `"model"`.
- Produces: shared model activity visible through `projectJobStatus`, and therefore through `subagent_status`, `/subagents`, and `formatLiveWidgetLines`.

- [ ] **Step 1: Add failing shared-projection and surface tests**

Extend the activity test in `test/job-status.test.ts` with a model record and exact expected kind. Keep only three records so the complete projected list is deterministic:

```ts
const status = projectJobStatus(job("running", { progress: [
  { type: "tool", text: "Completed read", timestamp: 2_200 },
  { type: "diagnostic", text: "Checking diagnostics", timestamp: 2_300 },
  { type: "model", text: "Model reasoning", timestamp: 2_400 },
] }), 2_500);
assert.deepEqual(status.recentActivity.map((item) => item.kind), ["tool", "diagnostic", "model"]);
assert.equal(status.recentActivity.at(-1)?.summary, "Model reasoning");
```

In `test/tools.test.ts`, before resolving the first controlled job in `tool renderers preserve task detail...`, publish model activity and request status while the job is running:

```ts
runner.started[0]?.options.onProgress({ type: "model", text: "Model reasoning", timestamp: 1_500 });
const runningStatus = await statusJobs({ id: "job-1" }, services);
assert.match(render("subagent_status", runningStatus, true), /Model reasoning/u);
```

In `test/dashboard.test.ts`, include this item in the compact-details fixture and assert it renders:

```ts
{ type: "model", text: "Model reasoning", timestamp: 2_800 },
```

```ts
assert.match(text, /Model reasoning/u);
```

In `test/live-widget.test.ts`, add a focused formatting test:

```ts
test("renders the latest model activity for a running job", () => {
  const text = render([job("running", "running", {
    progress: [{ type: "model", text: "Model reasoning", timestamp: 9_500 }],
  })]).map(plain);

  assert.equal(text[2], "     ⎿ Model reasoning");
});
```

The runner privacy test from Task 1 is the trust-boundary proof that hostile reasoning payload text never becomes a `ProgressItem`; these presentation tests consume only the fixed record emitted by that boundary.

- [ ] **Step 2: Run focused projection and surface tests to verify RED**

Run:

```sh
npx tsx --test --test-name-pattern="chronological activity|renders the latest model|tool renderers preserve|compact details use shared" test/job-status.test.ts test/tools.test.ts test/dashboard.test.ts test/live-widget.test.ts
```

Expected: the status projection test FAILS because model activity is currently classified as `diagnostic`. Surface display assertions may already pass through the shared generic summary path, which is acceptable; they are regression coverage for the final contract.

- [ ] **Step 3: Project model activity with a distinct kind**

In `src/job-status.ts`, extend the public-safe kind union:

```ts
export interface StatusActivity {
  timestamp: number;
  kind: "assistant" | "tool" | "diagnostic" | "model";
  summary: string;
}
```

In `projectJobStatus`, handle model activity before the diagnostic fallback:

```ts
if (item.type === "model") {
  return [{ timestamp: item.timestamp, kind: "model", summary: text }];
}
return [{ timestamp: item.timestamp, kind: "diagnostic", summary: text }];
```

Keep `boundedPreview` on every summary. Do not parse model labels in presentation code.

- [ ] **Step 4: Run focused projection and surface tests to verify GREEN**

Run:

```sh
npx tsx --test test/job-status.test.ts test/tools.test.ts test/dashboard.test.ts test/live-widget.test.ts
```

Expected: all selected tests pass. Confirm the existing `thinking…` live-widget fallback test still passes for a job with no activity.

- [ ] **Step 5: Document model activity and privacy**

In `README.md`, immediately after the paragraph describing the above-editor tree and before the `subagent_status` paragraph, add:

```markdown
Model-turn and reasoning events appear as fixed activity such as `Model turn started` and `Model reasoning`. During a long reasoning stream, the extension refreshes one bounded activity timestamp at most every five seconds. It never captures or displays the model's reasoning text. Heartbeats depend on the selected provider and model emitting Pi reasoning events; the extension does not invent activity when no event arrives.
```

Update the representative status example so one recent activity line is:

```text
  now      Model reasoning
```

Do not claim that every provider emits reasoning events or that this feature detects stalls.

- [ ] **Step 6: Run the complete required verification**

Run LSP before broad commands:

```text
lsp_diagnostics paths=[
  "src/types.ts",
  "src/process-runner.ts",
  "src/job-manager.ts",
  "src/job-status.ts"
] severity=all serverScope=primary
```

Expected: no primary TypeScript errors.

Then run:

```sh
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts test/job-status.test.ts test/tools.test.ts test/dashboard.test.ts test/live-widget.test.ts
npm test
npm run typecheck
npm pack --dry-run
```

Expected:

- All focused tests pass.
- The full test suite passes; real-Pi tests may remain explicitly skipped unless their opt-in environment variables are present.
- TypeScript reports no errors.
- Package dry-run succeeds and includes the intended source, README, and package metadata without unexpected generated files.

Run pi-lens diagnostics after the commands:

```text
lens_diagnostics mode=all
```

Expected: no blocking errors or unresolved warnings in edited files.

- [ ] **Step 7: Review the final diff against the approved boundaries**

Run:

```sh
git diff --check
git diff --stat HEAD~1
git status --short
rg -n "SECRET_|PRIVATE_AFTER_RESET|PRIVATE|thinking_delta" src README.md
```

Expected:

- `git diff --check` prints nothing.
- Only the files listed by this task are changed after the Task 2 commit.
- Secret test markers occur only in tests; no source or README line contains them.
- Source may match `thinking_delta` only in the event discriminator and must not read or retain its payload.
- No execution deadline, cancellation, child-extension, stall-detection, or unrelated profile change appears.

- [ ] **Step 8: Commit presentation and documentation**

```sh
git add src/job-status.ts README.md test/job-status.test.ts test/tools.test.ts \
  test/dashboard.test.ts test/live-widget.test.ts
git commit -m "feat: show model activity across status views"
```

- [ ] **Step 9: Confirm the branch is ready for review**

Run:

```sh
git status --short --branch
git log --oneline -5
```

Expected: clean working tree with three focused implementation commits above the approved design and plan commits.
