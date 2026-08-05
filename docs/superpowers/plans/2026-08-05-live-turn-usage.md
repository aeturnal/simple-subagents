# Live Turn-by-Turn Token Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exact cumulative subagent token usage after every completed assistant message so the existing live widget can show accurate turn-by-turn totals while the job is still running.

**Architecture:** `PiProcessRunner` will expose cumulative `UsageStats` through a dedicated optional callback after each assistant `message_end`. `JobManager` will copy those snapshots into the managed job and notify existing subscribers; the live widget will use its existing 80 ms render interval and unchanged `input + output` formatter.

**Tech Stack:** TypeScript, Node.js event streams, `node:test`, `tsx`, Pi JSON event mode, existing Pi TUI widget controller.

## Global Constraints

- Display only exact provider usage; do not estimate tokens from streamed text.
- Keep the live widget count combined as input tokens plus output tokens.
- Add no tokenizer dependency.
- Add no timer and do not increase the existing 80 ms redraw frequency.
- Keep usage out of `job.progress` and its bounded history.
- Preserve direct `ProcessRunner` compatibility by making `onUsage` optional.
- Accept usage updates only while a process-backed job is `running` or actively `cancelled` while awaiting settlement.
- Keep the final `ProcessResult.usage` authoritative for completed, failed, and cancelled jobs.
- Preserve existing `/subagents`, `subagent_status`, lifecycle, cancellation, and resource-cleanup behavior.

## File Structure

- Modify `src/process-runner.ts`: define the optional usage callback and emit cloned cumulative usage after each assistant message.
- Modify `test/process-runner.test.ts`: prove cumulative exact emission, field ordering, and callback isolation.
- Modify `src/job-manager.ts`: first publish running-job usage safely, then extend that state guard for cancelled work awaiting settlement.
- Modify `test/job-manager.test.ts`: separately prove running publication and cancelled-process publication, alongside synchronous-start safety, immutable copying, final replacement, and late-update rejection.
- Modify `README.md`: state that exact token usage advances after each completed model turn.
- No change to `src/live-widget.ts`: its formatter and animation already consume `job.usage` correctly.

---

### Task 1: Emit cumulative usage from `PiProcessRunner`

**Files:**

- Modify: `src/process-runner.ts:12-18, 170-195, 271-300`
- Test: `test/process-runner.test.ts:1-50, 313-333`

**Interfaces:**

- Consumes: existing `UsageStats` from `src/types.ts` and assistant `message_end` records from Pi JSON mode.
- Produces: optional `ProcessRunOptions.onUsage?(usage: UsageStats): void`, invoked with a cloned cumulative snapshot after every assistant `message_end`.

- [ ] **Step 1: Write the failing cumulative-usage test**

Update the type import in `test/process-runner.test.ts`:

```ts
import type { AgentProfile, JobRequest, ProgressItem, UsageStats } from "../src/types.ts";
```

Forward the optional callback from the existing `runOptions` test helper by adding this property after `onProgress`:

```ts
...(overrides.onUsage ? { onUsage: overrides.onUsage } : {}),
```

Add this test immediately after `reduces split assistant events into final output and accumulated usage`:

```ts
test("emits isolated cumulative usage after each assistant message", async () => {
  const { child, runner } = spawnedRunner();
  const snapshots: UsageStats[] = [];
  const running = runner.run(runOptions({
    onUsage: (nextUsage) => {
      snapshots.push(structuredClone(nextUsage));
      nextUsage.input = 999_999;
    },
  }));
  const emit = (usage: Record<string, unknown>): void => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], usage },
    })}\n`));
  };

  emit({ input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: { total: 0.25 } });
  emit({ input: 13, output: 17, cacheRead: 19, cacheWrite: 23, cost: { total: 0.5 } });

  assert.deepEqual(snapshots, [
    { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 0.25, turns: 1 },
    { input: 16, output: 22, cacheRead: 26, cacheWrite: 34, cost: 0.75, turns: 2 },
  ]);

  child.close();
  assert.deepEqual((await running.result).usage, snapshots[1]);
});
```

This mutation check proves that a callback cannot corrupt the runner's internal accumulator.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="emits isolated cumulative usage" test/process-runner.test.ts
```

Expected: FAIL because `onUsage` is not called. TypeScript-aware editors may also report that `onUsage` is not yet part of `ProcessRunOptions`; that is expected in RED.

- [ ] **Step 3: Add the optional callback interface**

In `src/process-runner.ts`, extend `ProcessRunOptions` without changing existing required callbacks:

```ts
export interface ProcessRunOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
  onProgress(item: ProgressItem): void;
  onUsage?(usage: UsageStats): void;
}
```

- [ ] **Step 4: Emit a complete cloned snapshot after each message**

Near the existing local progress emitters in `PiProcessRunner.run`, add:

```ts
const emitUsage = (): void => {
  options.onUsage?.(structuredClone(usage));
};
```

In the assistant `message_end` branch, call it only after turns and every usage field have been accumulated:

```ts
const eventUsage = asRecord(message.usage);
if (eventUsage) {
  usage.input += asNumber(eventUsage.input);
  usage.output += asNumber(eventUsage.output);
  usage.cacheRead += asNumber(eventUsage.cacheRead);
  usage.cacheWrite += asNumber(eventUsage.cacheWrite);
  const cost = asRecord(eventUsage.cost);
  usage.cost += cost ? asNumber(cost.total) : asNumber(eventUsage.cost);
}
emitUsage();
resultModel = asString(message.model) ?? resultModel;
```

Do not emit from text or thinking deltas. Do not place usage in `ProgressItem`.

- [ ] **Step 5: Run the focused runner tests and verify GREEN**

Run:

```bash
npx tsx --test test/process-runner.test.ts
```

Expected: all process-runner tests PASS, including direct callers that omit `onUsage`.

- [ ] **Step 6: Run type checking**

Run:

```bash
npm run typecheck
```

Expected: PASS with no diagnostics.

- [ ] **Step 7: Commit the runner contract**

```bash
git add src/process-runner.ts test/process-runner.test.ts
git commit -m "feat: stream cumulative subagent usage"
```

---

### Task 2: Publish usage for running jobs

**Files:**

- Modify: `src/job-manager.ts:314-384, 410-438`
- Test: `test/job-manager.test.ts:35-105, 155-170` and tests near existing progress/snapshot coverage
- Modify: `README.md:30-34`
- Verify unchanged: `src/live-widget.ts:48-66, 186-193`
- Verify unchanged: `test/live-widget.test.ts:138-159, 210-232`

**Interfaces:**

- Consumes: `ProcessRunOptions.onUsage?(usage: UsageStats): void` from Task 1.
- Produces: running `Job.usage` snapshots updated through the existing `JobManager.subscribe()` notification path, without publishing a running job before its process is registered.

- [ ] **Step 1: Extend the controlled test runner with usage delivery**

Add this helper beside `ControlledRunner.progress` in `test/job-manager.test.ts`:

```ts
usage(index: number, nextUsage: UsageStats): void {
  this.started[index]?.options.onUsage?.(nextUsage);
}
```

Add a synchronous test runner beside `SynchronousProgressRunner`:

```ts
class SynchronousUsageRunner extends ControlledRunner {
  run(options: ProcessRunOptions): RunningProcess {
    options.onUsage?.({ input: 8, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.25, turns: 1 });
    return super.run(options);
  }
}
```

- [ ] **Step 2: Write the failing running/final/late usage test**

Add this test near `returns immutable public snapshots`:

```ts
test("publishes live usage while running and keeps the final result authoritative", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  const observed: UsageStats[] = [];
  manager.subscribe((jobs) => {
    const current = jobs.find(({ id }) => id === job.id);
    if (current) observed.push(structuredClone(current.usage));
  });
  const live = { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 };

  runner.usage(0, live);
  live.input = 999;

  const expectedLive = { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 };
  assert.equal(manager.get(job.id)?.state, "running");
  assert.deepEqual(manager.get(job.id)?.usage, expectedLive);
  assert.deepEqual(observed.at(-1), expectedLive);
  assert.deepEqual(manager.get(job.id)?.progress, []);

  runner.complete(0, successfulResult("done"));
  await runner.flush();
  assert.deepEqual(manager.get(job.id)?.usage, usage());

  const notificationCount = observed.length;
  runner.usage(0, { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 9, turns: 9 });
  assert.deepEqual(manager.get(job.id)?.usage, usage());
  assert.equal(observed.length, notificationCount);
});
```

- [ ] **Step 3: Write the failing synchronous-registration safety test**

Add beside the synchronous-progress regression test:

```ts
test("buffers synchronous usage until the running process is registered", () => {
  const runner = new SynchronousUsageRunner();
  const manager = new JobManager({ runner });
  let publishedBeforeRegistration = false;

  manager.subscribe((jobs) => {
    if ((jobs[0]?.usage.input ?? 0) > 0 && runner.started.length === 0) {
      publishedBeforeRegistration = true;
    }
  });
  manager.enqueue(makeRequests(1), profiles, defaults);

  assert.equal(publishedBeforeRegistration, false);
  assert.deepEqual(manager.get("job-1")?.usage, {
    input: 8, output: 5, cacheRead: 3, cacheWrite: 2, cost: 0.25, turns: 1,
  });
});
```

- [ ] **Step 4: Run the focused manager tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="publishes live usage|buffers synchronous usage" test/job-manager.test.ts
```

Expected: both new tests FAIL because `JobManager` does not yet provide or store `onUsage`.

- [ ] **Step 5: Buffer usage emitted before process registration**

In `JobManager.pump`, add a latest-snapshot buffer beside `synchronousProgress`:

```ts
const synchronousProgress: ProgressItem[] = [];
let synchronousUsage: UsageStats | undefined;
let registered = false;
```

Pass the callback to `runner.run`:

```ts
onUsage: (nextUsage) => {
  if (registered) this.updateUsage(entry, nextUsage);
  else synchronousUsage = structuredClone(nextUsage);
},
```

After the process is placed in `this.active`, replay buffered state without publishing the running job before registration:

```ts
if (synchronousProgress.length === 0 && synchronousUsage === undefined) {
  this.notify();
} else {
  for (const item of synchronousProgress) this.addProgress(entry, item);
  if (synchronousUsage !== undefined) this.updateUsage(entry, synchronousUsage);
}
```

Keep this replay after `this.active.set`, `registered = true`, result-handler registration, `this.starting.delete(id)`, and cancellation routing, matching the current synchronous-progress safety order.

- [ ] **Step 6: Add the running-job usage update**

Add this private method immediately before `addProgress`:

```ts
private updateUsage(entry: InternalJob, nextUsage: UsageStats): void {
  if (entry.job.state !== "running") return;
  entry.job.usage = structuredClone(nextUsage);
  this.notify();
}
```

Do not add usage to progress. Leave `applyResult()` unchanged so settlement replaces live usage with `result.usage`. Task 3 will separately extend the state guard for cancelled work that is still awaiting process settlement.

- [ ] **Step 7: Run manager and widget tests and verify GREEN**

Run:

```bash
npx tsx --test test/job-manager.test.ts test/live-widget.test.ts test/dashboard.test.ts test/job-status.test.ts
```

Expected: all selected tests PASS. Existing live-widget tests must still show combined `input + output` totals, and timer-count tests must remain unchanged.

- [ ] **Step 8: Document exact turn-boundary updates**

Change the live-widget paragraph in `README.md` to:

```md
While jobs are queued or running, an above-editor tree shows each active subagent, its latest bounded activity, turns, tool uses, tokens, and elapsed time. Exact cumulative token usage updates after each completed model turn. Running rows use an animated spinner. Completed, failed, and cancelled rows remain visible for three seconds; `/subagents` remains the durable inbox view until the parent collects or discards a result.
```

- [ ] **Step 9: Verify and commit running-job publication**

Run:

```bash
npx tsx --test test/job-manager.test.ts test/live-widget.test.ts test/dashboard.test.ts test/job-status.test.ts
npm run typecheck
git diff --check
```

Expected: all selected tests PASS, type checking reports no diagnostics, and `git diff --check` prints nothing.

Commit:

```bash
git add src/job-manager.ts test/job-manager.test.ts README.md
git commit -m "feat: publish running subagent usage"
```

---

### Task 3: Accept usage from cancelled work awaiting settlement

**Files:**

- Modify: `src/job-manager.ts:410-414`
- Test: `test/job-manager.test.ts` near the cancellation-race coverage

**Interfaces:**

- Consumes: Task 2's private `updateUsage(entry: InternalJob, nextUsage: UsageStats): void` method.
- Produces: the same cumulative usage publication while a process-backed job is `cancelled` but its process has not settled.

- [ ] **Step 1: Write the failing active-cancelled usage test**

Add:

```ts
test("accepts usage while cancelled work awaits process settlement", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  const cancelling = manager.cancel(job.id);
  runner.releaseCancel(0);
  await cancelling;
  assert.equal(manager.get(job.id)?.state, "cancelled");

  runner.usage(0, { input: 7, output: 11, cacheRead: 2, cacheWrite: 3, cost: 0.4, turns: 1 });
  assert.deepEqual(manager.get(job.id)?.usage, {
    input: 7, output: 11, cacheRead: 2, cacheWrite: 3, cost: 0.4, turns: 1,
  });

  runner.complete(0, successfulResult("late result"));
  await runner.flush();
  assert.deepEqual(manager.get(job.id)?.usage, usage());
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="accepts usage while cancelled" test/job-manager.test.ts
```

Expected: FAIL because Task 2's state guard ignores usage once the job state is `cancelled`.

- [ ] **Step 3: Extend only the usage state guard**

Change `updateUsage` to:

```ts
private updateUsage(entry: InternalJob, nextUsage: UsageStats): void {
  if (entry.job.state !== "running" && entry.job.state !== "cancelled") return;
  entry.job.usage = structuredClone(nextUsage);
  this.notify();
}
```

Do not change cancellation, process settlement, or `applyResult()`. The test's final assertion proves the settled process result still replaces the active-cancelled snapshot.

- [ ] **Step 4: Run lifecycle and full verification**

Run:

```bash
npx tsx --test test/job-manager.test.ts test/live-widget.test.ts test/dashboard.test.ts test/job-status.test.ts
npm test
npm run typecheck
git diff --check
```

Expected: all tests PASS, type checking reports no diagnostics, and `git diff --check` prints nothing.

- [ ] **Step 5: Commit cancelled-process publication**

```bash
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "fix: retain usage during subagent cancellation"
```

---

## Final Verification

- [ ] Run primary language-server diagnostics on `src/process-runner.ts`, `src/job-manager.ts`, `test/process-runner.test.ts`, and `test/job-manager.test.ts`; expect zero errors.
- [ ] Run `npm test`; expect all non-integration tests to pass and only explicitly marked real-Pi integration tests to remain skipped when credentials are unavailable.
- [ ] Run `npm run typecheck`; expect success.
- [ ] Run `git diff --check HEAD~3..HEAD`; expect no output.
- [ ] Confirm `git status --short` is empty.
- [ ] Review the complete diff against `docs/superpowers/specs/2026-08-05-live-turn-usage-design.md`, specifically checking callback cloning, synchronous startup, cancelled-process settlement, late callbacks, final-result authority, unchanged timer counts, and unchanged combined token formatting.
