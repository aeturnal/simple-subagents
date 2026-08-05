# Live Widget Priority Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the live widget's ending details visible, publish turns/tokens/model while jobs run, and linger finished jobs for five seconds.

**Architecture:** Add one small telemetry callback from `PiProcessRunner` to `JobManager`, emitted once per assistant `message_end`. Build each widget row from a fixed prefix, flexible task, and reserved suffix using Pi TUI's existing width helpers; do not add a new rendering abstraction or dependency.

**Tech Stack:** TypeScript, Node.js test runner through `tsx`, `@earendil-works/pi-tui` width utilities.

## Global Constraints

- Keep the implementation simple and local; do not add dependencies or new source files.
- Do not change `/subagents`, launch selection, lifecycle, collection, discard, cancellation, or concurrency behavior.
- Display tokens as `usage.input + usage.output`; do not add cache counters again.
- Emit telemetry once per completed assistant message, not per streamed token.
- Preserve field order: turns, tool uses, tokens, model, thinking, duration.
- Preserve the complete suffix before allocating task width; truncate suffix only after the task is gone.
- Keep every line within the supplied terminal width.
- Use an exact terminal linger duration of `5_000` ms.

---

## File Map

- `src/process-runner.ts`: define and emit accumulated live telemetry.
- `src/job-manager.ts`: apply telemetry to running job snapshots.
- `src/live-widget.ts`: add model details, priority width allocation, and five-second linger.
- `test/process-runner.test.ts`: prove telemetry timing and accumulation.
- `test/job-manager.test.ts`: prove live manager updates, startup buffering, and final authority.
- `test/live-widget.test.ts`: prove suffix ordering, truncation priority, model fallback, and linger timing.
- `README.md`: describe model display, priority details, and five-second linger.

### Task 1: Emit live process telemetry

**Files:**

- Modify: `src/process-runner.ts:12-18,205-309`
- Test: `test/process-runner.test.ts:1-52,313-336`

**Interfaces:**

- Produces:

```ts
export interface ProcessTelemetry {
  readonly usage: Readonly<UsageStats>;
  readonly model?: string;
}

export interface ProcessRunOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
  onProgress(item: ProgressItem): void;
  onTelemetry?(telemetry: ProcessTelemetry): void;
}
```

The callback is optional so existing `ProcessRunner` implementations remain compatible. Every emitted `usage` object is a fresh copy.

- [ ] **Step 1: Write the failing telemetry test**

Import `ProcessTelemetry`, then add this focused test beside the existing accumulated-usage test:

```ts
test("emits accumulated telemetry after each assistant message", async () => {
  const { child, runner } = spawnedRunner();
  const telemetry: ProcessTelemetry[] = [];
  const running = runner.run(runOptions({
    onTelemetry: (update) => telemetry.push(update),
  }));
  const emit = (event: unknown): void => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  };

  emit({
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: { total: 0.25 } },
      model: "openai-codex/gpt-5.6-terra",
    },
  });
  emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "secret" } });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input: 13, output: 17 },
      model: "openai-codex/gpt-5.6-sol",
    },
  });

  assert.deepEqual(telemetry, [
    {
      usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 0.25, turns: 1 },
      model: "openai-codex/gpt-5.6-terra",
    },
    {
      usage: { input: 16, output: 22, cacheRead: 7, cacheWrite: 11, cost: 0.25, turns: 2 },
      model: "openai-codex/gpt-5.6-sol",
    },
  ]);

  child.close();
  const result = await running.result;
  assert.deepEqual(result.usage, telemetry.at(-1)?.usage);
  assert.equal(result.model, telemetry.at(-1)?.model);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```sh
npx tsx --test --test-name-pattern "emits accumulated telemetry" test/process-runner.test.ts
```

Expected: FAIL because `ProcessTelemetry` and `onTelemetry` do not exist.

- [ ] **Step 3: Add the minimal callback and emit it from `message_end`**

Add the interface and optional callback shown above. In the assistant `message_end` branch, keep the existing usage accumulation, update `resultModel`, then emit one copy. Only publish a model when that message reported one; the widget already owns launch-model fallback:

```ts
const reportedModel = asString(message.model);
resultModel = reportedModel ?? resultModel;
options.onTelemetry?.({
  usage: { ...usage },
  ...(reportedModel === undefined ? {} : { model: reportedModel }),
});
```

Leave text, thinking, tool, settlement, and final-result handling unchanged.

- [ ] **Step 4: Run process-runner tests**

Run:

```sh
npx tsx --test test/process-runner.test.ts
```

Expected: all process-runner tests PASS.

- [ ] **Step 5: Commit the runner change**

```sh
git add src/process-runner.ts test/process-runner.test.ts
git commit -m "feat: emit live subagent telemetry"
```

### Task 2: Publish telemetry through `JobManager`

**Files:**

- Modify: `src/job-manager.ts:1-5,314-436`
- Test: `test/job-manager.test.ts:1-112,150-168,280-360`

**Interfaces:**

- Consumes: `ProcessTelemetry` and `ProcessRunOptions.onTelemetry` from Task 1.
- Produces: running `Job` snapshots whose `usage` and `model` update before `ProcessResult` settles.

- [ ] **Step 1: Extend the controlled test runner and add failing manager tests**

Import `ProcessTelemetry`. Add this method to `ControlledRunner`:

```ts
telemetry(index: number, update: ProcessTelemetry): void {
  this.started[index]?.options.onTelemetry?.(update);
}
```

Add a synchronous test runner:

```ts
class SynchronousTelemetryRunner extends ControlledRunner {
  override run(options: ProcessRunOptions): RunningProcess {
    options.onTelemetry?.({ usage: usage(), model: "live-model" });
    return super.run(options);
  }
}
```

Add these tests near the existing launch-model tests:

```ts
test("publishes immutable live telemetry before process settlement", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  manager.enqueue(makeRequests(1), profiles, defaults);
  const update = { usage: usage(), model: "openai-codex/gpt-5.6-sol" };
  let notifications = 0;
  manager.subscribe(() => { notifications += 1; });
  const before = notifications;

  runner.telemetry(0, update);
  update.usage.input = 999;

  assert.deepEqual(manager.get("job-1")?.usage, usage());
  assert.equal(manager.get("job-1")?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(manager.get("job-1")?.state, "running");
  assert.equal(notifications, before + 1);
});

test("keeps synchronous startup telemetry", () => {
  const manager = new JobManager({ runner: new SynchronousTelemetryRunner() });
  manager.enqueue(makeRequests(1), profiles, defaults);

  assert.deepEqual(manager.get("job-1")?.usage, usage());
  assert.equal(manager.get("job-1")?.model, "live-model");
});

test("final result overrides live telemetry and late telemetry is ignored", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  manager.enqueue(makeRequests(1), profiles, defaults);
  runner.telemetry(0, {
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
    model: "live-model",
  });

  runner.complete(0, successfulResult("done"));
  await runner.flush();
  runner.telemetry(0, {
    usage: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 99 },
    model: "late-model",
  });

  assert.deepEqual(manager.get("job-1")?.usage, usage());
  assert.equal(manager.get("job-1")?.model, "test-model");
});
```

- [ ] **Step 2: Run the focused manager tests and verify they fail**

Run:

```sh
npx tsx --test --test-name-pattern "telemetry" test/job-manager.test.ts
```

Expected: FAIL because `JobManager` does not pass or apply `onTelemetry`.

- [ ] **Step 3: Apply telemetry with one small manager method**

Import `ProcessTelemetry`. Add this method beside `addProgress`:

```ts
private applyTelemetry(entry: InternalJob, telemetry: ProcessTelemetry): void {
  if (entry.job.state !== "running") return;
  entry.job.usage = structuredClone(telemetry.usage);
  if (telemetry.model !== undefined) entry.job.model = telemetry.model;
  this.notify();
}
```

In `pump()`, declare the latest startup value next to `synchronousProgress`:

```ts
let synchronousTelemetry: ProcessTelemetry | undefined;
```

Pass this callback to `runner.run`. The normal path clones once inside `applyTelemetry`; only a pre-registration value needs an early copy:

```ts
onTelemetry: (telemetry) => {
  if (registered) this.applyTelemetry(entry, telemetry);
  else synchronousTelemetry = structuredClone(telemetry);
},
```

After registration, keep the existing progress loop and apply the buffered telemetry once. Avoid an extra initial notification when either buffered progress or telemetry will already notify:

```ts
if (synchronousProgress.length === 0 && synchronousTelemetry === undefined) this.notify();
else {
  for (const item of synchronousProgress) this.addProgress(entry, item);
  if (synchronousTelemetry !== undefined) this.applyTelemetry(entry, synchronousTelemetry);
}
```

Do not alter `applyResult`; it already replaces usage and model with final values.

- [ ] **Step 4: Run manager and runner tests**

Run:

```sh
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the manager change**

```sh
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: publish live subagent usage"
```

### Task 3: Reserve widget details and extend linger time

**Files:**

- Modify: `src/live-widget.ts:1-93,201-217`
- Test: `test/live-widget.test.ts:85-159,210-270`
- Modify: `README.md:25-30`

**Interfaces:**

- Consumes: live `Job.usage`, `Job.model`, `Job.launchModel`, and existing Pi TUI `visibleWidth`, `truncateToWidth`, and `sliceByColumn`.
- Produces: the existing `formatLiveWidgetLines(jobs, options): string[]` API with priority suffix rendering and five-second linger.

- [ ] **Step 1: Add failing model, width-priority, and linger tests**

Replace the three-second boundary test with:

```ts
test("lingers before but not at the exact five-second boundary", () => {
  const finished = job("done", "completed", { finishedAt: 8_000 });
  assert.notDeepEqual(render([finished], 12_999), []);
  assert.deepEqual(render([finished], 13_000), []);
});
```

Expand the statistics test job with:

```ts
model: "openai-codex/gpt-5.6-sol",
launchModel: "openai-codex/gpt-5.6-terra",
launchThinkingLevel: "high",
```

Assert the complete order:

```ts
assert.match(text, /↻2 · 2 tool uses · 12\.4k tokens · gpt-5\.6-sol · high · 8\.0s$/);
```

Add launch-model fallback and width-priority tests:

```ts
test("uses the short observed model then falls back to the launch model", () => {
  const observed = plain(render([job("observed", "running", {
    model: "openai-codex/gpt-5.6-sol",
    launchModel: "openai-codex/gpt-5.6-terra",
  })])[1] ?? "");
  const launch = plain(render([job("launch", "running", {
    launchModel: "openai-codex/gpt-5.6-terra",
  })])[1] ?? "");

  assert.match(observed, /gpt-5\.6-sol · 8\.0s$/);
  assert.match(launch, /gpt-5\.6-terra · 8\.0s$/);
});

test("truncates the task before the complete detail suffix", () => {
  const rich = job("wide", "running", {
    request: { task: "A very long task with emoji 😀 and CJK 漢字 that must shrink", agent: "reviewer", writeAccess: false },
    usage: { input: 12_000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
    progress: [{ type: "tool", text: "Started read", timestamp: 3_000 }],
    model: "openai-codex/gpt-5.6-sol",
    launchThinkingLevel: "high",
  });
  const suffix = "· ↻2 · 1 tool use · 12.4k tokens · gpt-5.6-sol · high · 8.0s";
  const prefix = "└─ ⠋ reviewer";
  const width = visibleWidth(prefix) + 2 + 12 + 1 + visibleWidth(suffix);
  const row = plain(render([rich], 10_000, 0, width)[1] ?? "");
  const noTask = plain(render([rich], 10_000, 0, visibleWidth(prefix) + 2 + visibleWidth(suffix))[1] ?? "");
  const extreme = plain(render([rich], 10_000, 0, visibleWidth(prefix) + 18)[1] ?? "");

  assert.equal(row.endsWith(suffix), true);
  assert.match(row, /A very lo\.\.\. · ↻2/);
  assert.equal(noTask, `${prefix}  ${suffix}`);
  assert.equal(extreme.endsWith("high · 8.0s"), true);
  assert.equal(visibleWidth(extreme) <= visibleWidth(prefix) + 18, true);
});
```

Update the controller expiry test to use the five-second deadlines:

```ts
widget.setJobs([
  job("first", "completed", { finishedAt: 8_000 }),
  job("second", "failed", { finishedAt: 9_000 }),
]);
assert.equal(h.clock.intervals.size, 0);
assert.equal(h.clock.timeouts.size, 1);
assert.equal([...h.clock.timeouts.values()][0]?.delay, 3_000);

h.clock.now = 13_000;
[...h.clock.timeouts.values()][0]!.callback();
assert.equal([...h.clock.timeouts.values()][0]?.delay, 1_000);
assert.equal(plain(h.render().join("\n")).includes("first"), false);
assert.equal(plain(h.render().join("\n")).includes("second"), true);

h.clock.now = 14_000;
[...h.clock.timeouts.values()][0]!.callback();
assert.equal(h.clock.timeouts.size, 0);
assert.equal(h.factory, undefined);
```

- [ ] **Step 2: Run live-widget tests and verify they fail**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: FAIL on missing model text, whole-row truncation, and the old three-second linger.

- [ ] **Step 3: Implement the small formatter changes**

Import the existing width helpers:

```ts
import { sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
```

Change:

```ts
const LINGER_MS = 5_000;
```

Add the model to `formatStats` before thinking:

```ts
const model = (job.model ?? job.launchModel)?.split("/").at(-1);
if (model) parts.push(model);
if (job.launchThinkingLevel) parts.push(job.launchThinkingLevel);
```

Add only these two local helpers:

```ts
const tailToWidth = (text: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  const textWidth = visibleWidth(text);
  return textWidth <= safeWidth ? text : sliceByColumn(text, textWidth - safeWidth, safeWidth, true);
};

const formatJobRow = (prefix: string, task: string, details: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= safeWidth) return truncateToWidth(prefix, safeWidth, "");

  const detailsWidth = visibleWidth(details);
  const taskWidth = safeWidth - prefixWidth - 3 - detailsWidth;
  if (taskWidth > 0) return `${prefix}  ${truncateToWidth(task, taskWidth)} ${details}`;
  if (safeWidth >= prefixWidth + 2 + detailsWidth) return `${prefix}  ${details}`;
  return `${prefix}${tailToWidth(`  ${details}`, safeWidth - prefixWidth)}`;
};
```

In `formatLiveWidgetLines`, replace whole-row construction with separate styled parts:

```ts
const prefix = `${theme.fg("dim", connector)} ${stateIcon(job, frame, theme)} ${agent}`;
const task = theme.fg("muted", status.task);
const details = theme.fg("dim", `· ${formatStats(job, now)}`);
lines.push(formatJobRow(prefix, task, details, width));
```

Keep the final `truncateToWidth` map as a defensive bound for headings and activity rows. Do not introduce a generic layout class or another module.

- [ ] **Step 4: Update the README**

Replace the current widget paragraph with:

```md
While jobs are queued or running, an above-editor tree shows each active subagent, its latest bounded activity, turns, tool uses, tokens, short model name, thinking level, and elapsed time. Running usage updates after each completed assistant response. On narrow terminals, task text shrinks before the ending details. Running rows use an animated spinner. Completed, failed, and cancelled rows remain visible for five seconds; `/subagents` remains the durable inbox view until the parent collects or discards a result.
```

- [ ] **Step 5: Run widget tests and typecheck**

Run:

```sh
npx tsx --test test/live-widget.test.ts
npm run typecheck
```

Expected: all widget tests PASS and TypeScript reports no errors.

- [ ] **Step 6: Commit the widget and documentation change**

```sh
git add src/live-widget.ts test/live-widget.test.ts README.md
git commit -m "feat: preserve live widget details"
```

## Final Verification

- [ ] Run focused tests:

```sh
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts test/live-widget.test.ts
```

Expected: all selected tests PASS.

- [ ] Run the complete suite and typecheck:

```sh
npm test
npm run typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] Run LSP diagnostics before any build or completion claim:

```text
lsp_diagnostics paths=["src/process-runner.ts", "src/job-manager.ts", "src/live-widget.ts", "test/process-runner.test.ts", "test/job-manager.test.ts", "test/live-widget.test.ts"] severity="all"
```

Expected: no errors.

- [ ] Run session diagnostics:

```text
lens_diagnostics mode="all"
```

Expected: no blocking errors or unresolved warnings in edited files.

- [ ] Inspect the final diff:

```sh
git diff HEAD~3 --check
git status --short --branch
```

Expected: no whitespace errors and only expected branch-ahead status.
