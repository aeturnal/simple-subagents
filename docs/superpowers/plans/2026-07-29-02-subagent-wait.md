# Bounded Subagent Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, event-driven `subagent_wait` tool that waits once for any or all requested jobs to settle, then returns state-only snapshots without collecting or cancelling work.

**Architecture:** Put wait lifecycle ownership in `JobManager`, using its existing subscription stream plus one injected timer and one optional abort listener per active wait. Keep the tool layer thin: TypeBox validates public bounds, execution turns expected ID errors into normal diagnostics, and a wait-specific details union prevents child output from entering wait results or rendering.

**Tech Stack:** TypeScript 5.9, Node.js 22.19 built-ins, Pi extension/TUI APIs 0.82.x, TypeBox, Node's test runner through `tsx`.

## Global Constraints

- Start from the released Plan 01 state and preserve its stale-safe notification behavior.
- Default wait: `15_000` ms.
- Maximum wait: `30_000` ms.
- Minimum wait: `100` ms.
- `ids` contains 1–8 strings and duplicate IDs produce a normal actionable diagnostic.
- `until` is optional, uses `StringEnum`, and defaults to `"all"`.
- Waiting is event-driven and never indefinite or repeatedly self-scheduled.
- Timeout, abort, and manager shutdown must not call `JobManager.cancel()` on behalf of a wait.
- Settled states are exactly `completed`, `failed`, `cancelled`, `collected`, and `discarded`.
- Wait details contain only IDs and states; final output, stderr, progress, tasks, usage, and profile internals must remain absent.
- Every exit path removes its manager subscription, timer, abort listener, and waiter registration before resolving.
- Keep the extension memory-only and add no runtime dependency or orchestration abstraction.
- Preserve the existing four-job concurrency limit, eight-job batch limit, completion notifier, tools, and dashboard behavior.
- Requires Node.js 22.19 or newer and Pi 0.82.x.

---

## File Structure

- `src/job-manager.ts` — define wait interfaces, own waiter/timer/abort lifecycle, and settle waiters before shutdown cancellation.
- `src/tools.ts` — define the public schema, state-only tool details, execution formatting, registration, signal forwarding, and compact/expanded rendering.
- `test/job-manager.test.ts` — exercise manager conditions, state semantics, fake time, races, simultaneous waits, shutdown, and cleanup.
- `test/tools.test.ts` — exercise schema/defaults, diagnostics, tool-boundary abort behavior, data isolation, and rendering.
- `README.md` — document the responsiveness limit, 30-second cap, abort semantics, and timeout guidance.
- `test/package.test.ts` — lock the required README lifecycle guidance with a focused documentation test.

## Public Interfaces

```typescript
export type WaitUntil = "any" | "all";
export type WaitOutcome = "completed" | "timed_out" | "aborted";

export interface WaitJobStatus {
  id: string;
  state: JobState;
}

export interface WaitResult {
  operation: "wait";
  outcome: WaitOutcome;
  until: WaitUntil;
  timeoutMs: number;
  elapsedMs: number;
  jobs: WaitJobStatus[];
}

export interface WaitForOptions {
  ids: readonly string[];
  until: WaitUntil;
  timeoutMs: number;
  signal?: AbortSignal;
}

JobManager.waitFor(options: WaitForOptions): Promise<WaitResult>
waitJobs(input: WaitInput, services: ToolServices, signal?: AbortSignal): Promise<ToolResponse>
```

`JobManager.waitFor()` rejects with `Error("Duplicate job ID: <id>")` or the existing `Error("Unknown job: <id>")` before installing resources. `waitJobs()` catches only those expected validation messages and returns them as ordinary tool diagnostics; unexpected manager failures continue to reject.

---

### Task 1: Add validated immediate manager waits

**Files:**
- Modify: `src/job-manager.ts:1-48,305-326`
- Test: `test/job-manager.test.ts` (append focused wait tests)

**Interfaces:**
- Consumes: `JobManager.get()`, `JobManager.list()`, and `isSettled(state: JobState)` from `src/types.ts`.
- Produces: exported `WaitUntil`, `WaitOutcome`, `WaitJobStatus`, `WaitResult`, `WaitForOptions`, and `JobManager.waitFor(options): Promise<WaitResult>`.
- Validation errors are exactly `Duplicate job ID: job-1` and `Unknown job: missing`.

- [ ] **Step 1: Write failing tests for atomic validation and immediate completion**

Add `isSettled` to the type import in `test/job-manager.test.ts`, then append:

```typescript
test("waitFor validates duplicate and unknown IDs before installing wait resources", async () => {
  const runner = new ControlledRunner();
  const timerDelays: number[] = [];
  const manager = new JobManager({
    runner,
    setTimer: (_callback, delay) => {
      timerDelays.push(delay);
      return delay;
    },
    clearTimer: () => {},
  });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  let subscribeCalls = 0;
  const subscribe = manager.subscribe.bind(manager);
  manager.subscribe = (listener) => {
    subscribeCalls += 1;
    return subscribe(listener);
  };

  await assert.rejects(
    manager.waitFor({ ids: [job.id, job.id], until: "all", timeoutMs: 1_000 }),
    /Duplicate job ID: job-1/,
  );
  await assert.rejects(
    manager.waitFor({ ids: [job.id, "missing"], until: "all", timeoutMs: 1_000 }),
    /Unknown job: missing/,
  );
  assert.deepEqual(timerDelays, []);
  assert.equal(subscribeCalls, 0);
});

test("waitFor immediately returns state-only snapshots when all jobs are settled", async () => {
  let now = 250;
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, now: () => now });
  const [completedJob, discardedJob] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(completedJob && discardedJob);
  runner.complete(0, successfulResult("private completed output"));
  runner.complete(1, failedResult({ output: "private failed output" }));
  await runner.flush();
  manager.discard(discardedJob.id);
  now = 400;

  const result = await manager.waitFor({
    ids: [completedJob.id, discardedJob.id],
    until: "all",
    timeoutMs: 15_000,
  });

  assert.deepEqual(result, {
    operation: "wait",
    outcome: "completed",
    until: "all",
    timeoutMs: 15_000,
    elapsedMs: 0,
    jobs: [
      { id: completedJob.id, state: "completed" },
      { id: discardedJob.id, state: "discarded" },
    ],
  });
  assert.equal("output" in result.jobs[0]!, false);
  assert.equal(result.jobs.every((job) => isSettled(job.state)), true);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="waitFor validates|waitFor immediately"
```

Expected: FAIL because the constructor has no timer dependencies and `waitFor` does not exist.

- [ ] **Step 3: Add the wait types and constructor timer seam**

In `src/job-manager.ts`, import `isSettled` as a value and add these exports below the constants:

```typescript
import { isSettled, type AgentProfile, type Job, type JobRequest, type JobState, type ProgressItem, type UsageStats } from "./types.js";

export type WaitUntil = "any" | "all";
export type WaitOutcome = "completed" | "timed_out" | "aborted";

export interface WaitJobStatus {
  id: string;
  state: JobState;
}

export interface WaitResult {
  operation: "wait";
  outcome: WaitOutcome;
  until: WaitUntil;
  timeoutMs: number;
  elapsedMs: number;
  jobs: WaitJobStatus[];
}

export interface WaitForOptions {
  ids: readonly string[];
  until: WaitUntil;
  timeoutMs: number;
  signal?: AbortSignal;
}
```

Add timer fields and extend the constructor without changing existing callers:

```typescript
private readonly setTimer: (callback: () => void, delay: number) => unknown;
private readonly clearTimer: (timer: unknown) => void;

constructor(options: {
  runner: ProcessRunner;
  concurrency?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const concurrency = options.concurrency ?? MAX_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error("Concurrency must be an integer between 1 and 4");
  }

  this.runner = options.runner;
  this.concurrency = concurrency;
  this.now = options.now ?? Date.now;
  this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
}
```

- [ ] **Step 4: Implement validation, snapshots, and the immediate path**

Add these methods after `subscribe()`; the temporary rejection at the end is intentionally the minimal RED-to-GREEN implementation for this task and is removed in Task 2:

```typescript
async waitFor(options: WaitForOptions): Promise<WaitResult> {
  const seen = new Set<string>();
  for (const id of options.ids) {
    if (seen.has(id)) throw new Error(`Duplicate job ID: ${id}`);
    seen.add(id);
    this.requireJob(id);
  }

  const startedAt = this.now();
  const jobs = this.waitSnapshots(options.ids);
  if (this.waitSatisfied(jobs, options.until)) {
    return {
      operation: "wait",
      outcome: "completed",
      until: options.until,
      timeoutMs: options.timeoutMs,
      elapsedMs: this.now() - startedAt,
      jobs,
    };
  }

  throw new Error("Wait condition is not yet satisfied");
}

private waitSnapshots(ids: readonly string[]): WaitJobStatus[] {
  return ids.map((id) => {
    const entry = this.requireJob(id);
    return { id, state: entry.job.state };
  });
}

private waitSatisfied(jobs: readonly WaitJobStatus[], until: WaitUntil): boolean {
  return until === "any"
    ? jobs.some((job) => isSettled(job.state))
    : jobs.every((job) => isSettled(job.state));
}
```

Do not expose `Job` snapshots from this API.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="waitFor validates|waitFor immediately"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the immediate wait contract**

```bash
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: add immediate subagent wait contract"
```

---

### Task 2: Complete event-driven `any` and `all` waits

**Files:**
- Modify: `src/job-manager.ts:130-190`
- Test: `test/job-manager.test.ts` (append condition tests)

**Interfaces:**
- Consumes: `waitSnapshots()` and `waitSatisfied()` from Task 1 plus the existing synchronous `subscribe(listener): unsubscribe` contract.
- Produces: pending `waitFor()` calls that settle on manager notifications for `until: "any"` and `until: "all"`.
- Preserves requested ID order in every `jobs` array.

- [ ] **Step 1: Write failing tests for event-driven `any` and `all`**

Append:

```typescript
test("waitFor any settles on the first failed or cancelled requested job", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 2 });
  const [first, second] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(first && second);

  const waiting = manager.waitFor({ ids: [first.id, second.id], until: "any", timeoutMs: 30_000 });
  runner.complete(1, failedResult());
  const result = await waiting;

  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.jobs.map(({ id, state }) => [id, state]), [
    [first.id, "running"],
    [second.id, "failed"],
  ]);
  assert.equal(runner.started[0]?.cancelCalls, 0);
});

test("waitFor all ignores queued and running states until every requested job settles", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  const [first, second] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(first && second);

  let resolved = false;
  const waiting = manager.waitFor({ ids: [second.id, first.id], until: "all", timeoutMs: 30_000 });
  void waiting.then(() => { resolved = true; });
  runner.complete(0, successfulResult("first"));
  await runner.flush();
  assert.equal(resolved, false);
  assert.equal(manager.get(second.id)?.state, "running");

  runner.complete(1, successfulResult("second"));
  await runner.flush();
  const result = await waiting;
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.jobs.map(({ id, state }) => [id, state]), [
    [second.id, "completed"],
    [first.id, "completed"],
  ]);
});

test("waitFor treats cancelled, collected, and discarded jobs as settled", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 3 });
  const [collected, discarded, cancelled] = manager.enqueue(makeRequests(3), profiles, defaults);
  assert.ok(collected && discarded && cancelled);
  runner.complete(0, successfulResult("collect me"));
  runner.complete(1, successfulResult("discard me"));
  await runner.flush();
  manager.collect(collected.id);
  manager.discard(discarded.id);
  const cancelling = manager.cancel(cancelled.id);
  runner.releaseCancel(2);
  await cancelling;

  const result = await manager.waitFor({
    ids: [cancelled.id, collected.id, discarded.id],
    until: "all",
    timeoutMs: 30_000,
  });

  assert.deepEqual(result.jobs, [
    { id: cancelled.id, state: "cancelled" },
    { id: collected.id, state: "collected" },
    { id: discarded.id, state: "discarded" },
  ]);
});
```

- [ ] **Step 2: Run the condition tests and verify RED**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="waitFor any|waitFor all"
```

Expected: FAIL with `Wait condition is not yet satisfied`.

- [ ] **Step 3: Replace the temporary rejection with one guarded subscription path**

Replace `throw new Error("Wait condition is not yet satisfied")` with:

```typescript
return new Promise<WaitResult>((resolve) => {
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  const settleCompleted = () => {
    if (settled) return;
    const current = this.waitSnapshots(options.ids);
    if (!this.waitSatisfied(current, options.until)) return;
    settled = true;
    unsubscribe?.();
    resolve({
      operation: "wait",
      outcome: "completed",
      until: options.until,
      timeoutMs: options.timeoutMs,
      elapsedMs: this.now() - startedAt,
      jobs: current,
    });
  };

  unsubscribe = this.subscribe(settleCompleted);
  if (settled) unsubscribe();
});
```

The `settled` guard and post-assignment unsubscribe handle the existing synchronous first `subscribe()` call without double settlement. Do not poll or schedule another wait.

- [ ] **Step 4: Run focused and manager regression tests**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="waitFor"
npx tsx --test test/job-manager.test.ts
npm run typecheck
```

Expected: PASS for `any`, `all`, immediate satisfaction, validation, and all existing manager tests.

- [ ] **Step 5: Commit event-driven conditions**

```bash
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: wait for subagent state changes"
```

---

### Task 3: Add timeout, abort, race, and resource cleanup semantics

**Files:**
- Modify: `src/job-manager.ts:130-215`
- Test: `test/job-manager.test.ts` (add fake clock and lifecycle tests)

**Interfaces:**
- Consumes: constructor `now`, `setTimer`, and `clearTimer` dependencies from Task 1.
- Produces: `timed_out` and `aborted` `WaitResult` outcomes through the same guarded settlement callback.
- Abort removes its listener and never invokes process cancellation.

- [ ] **Step 1: Add deterministic timer and abort fakes**

Place these near `ControlledRunner` in `test/job-manager.test.ts`:

```typescript
class WaitClock {
  now = 0;
  nextId = 1;
  readonly timers = new Map<number, { callback: () => void; delay: number }>();
  readonly cleared: number[] = [];

  setTimer = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clearTimer = (timer: unknown): void => {
    const id = timer as number;
    this.cleared.push(id);
    this.timers.delete(id);
  };

  fire(id = this.timers.keys().next().value as number): void {
    const timer = this.timers.get(id);
    assert.ok(timer);
    this.timers.delete(id);
    this.now += timer.delay;
    timer.callback();
  }
}

class TrackedAbortSignal extends EventTarget {
  aborted = false;
  addCalls = 0;
  removeCalls = 0;

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void {
    this.addCalls += 1;
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean): void {
    this.removeCalls += 1;
    super.removeEventListener(type, listener, options);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }
}
```

- [ ] **Step 2: Write failing timeout and abort cleanup tests**

Append:

```typescript
test("waitFor times out normally with current states and no job mutation", async () => {
  const clock = new WaitClock();
  const runner = new ControlledRunner();
  const manager = new JobManager({
    runner,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  const before = manager.get(job.id);

  const waiting = manager.waitFor({ ids: [job.id], until: "all", timeoutMs: 15_000 });
  assert.deepEqual([...clock.timers.values()].map(({ delay }) => delay), [15_000]);
  clock.fire();
  const result = await waiting;

  assert.deepEqual(result, {
    operation: "wait",
    outcome: "timed_out",
    until: "all",
    timeoutMs: 15_000,
    elapsedMs: 15_000,
    jobs: [{ id: job.id, state: "running" }],
  });
  assert.equal(manager.get(job.id)?.state, before?.state);
  assert.equal(runner.started[0]?.cancelCalls, 0);
  assert.equal(clock.timers.size, 0);
});

test("waitFor installs the configured minimum and maximum timeout delays", async () => {
  const clock = new WaitClock();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  const minimumAbort = new AbortController();
  const maximumAbort = new AbortController();

  const minimum = manager.waitFor({ ids: [job.id], until: "all", timeoutMs: 100, signal: minimumAbort.signal });
  const maximum = manager.waitFor({ ids: [job.id], until: "all", timeoutMs: 30_000, signal: maximumAbort.signal });
  assert.deepEqual([...clock.timers.values()].map(({ delay }) => delay), [100, 30_000]);

  minimumAbort.abort();
  maximumAbort.abort();
  assert.deepEqual((await Promise.all([minimum, maximum])).map(({ outcome }) => outcome), ["aborted", "aborted"]);
  assert.equal(clock.timers.size, 0);
});

test("waitFor aborts with current states and removes timer and abort listener", async () => {
  const clock = new WaitClock();
  const signal = new TrackedAbortSignal();
  const runner = new ControlledRunner();
  const manager = new JobManager({
    runner,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  let activeSubscriptions = 0;
  const subscribe = manager.subscribe.bind(manager);
  manager.subscribe = (listener) => {
    activeSubscriptions += 1;
    const unsubscribe = subscribe(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      activeSubscriptions -= 1;
      unsubscribe();
    };
  };

  const waiting = manager.waitFor({
    ids: [job.id],
    until: "all",
    timeoutMs: 30_000,
    signal: signal as AbortSignal,
  });
  clock.now = 25;
  signal.abort();
  const result = await waiting;

  assert.equal(result.outcome, "aborted");
  assert.equal(result.elapsedMs, 25);
  assert.deepEqual(result.jobs, [{ id: job.id, state: "running" }]);
  assert.equal(signal.addCalls, 1);
  assert.equal(signal.removeCalls, 1);
  assert.deepEqual(clock.cleared, [1]);
  assert.equal(clock.timers.size, 0);
  assert.equal(activeSubscriptions, 0);
  assert.equal(runner.started[0]?.cancelCalls, 0);
});
```

- [ ] **Step 3: Write failing completion race tests**

Append:

```typescript
test("waitFor completion wins once against later timeout and abort callbacks", async () => {
  const clock = new WaitClock();
  const signal = new TrackedAbortSignal();
  const runner = new ControlledRunner();
  const manager = new JobManager({
    runner,
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  const waiting = manager.waitFor({ ids: [job.id], until: "all", timeoutMs: 100, signal: signal as AbortSignal });
  const timeoutCallback = [...clock.timers.values()][0]?.callback;
  assert.ok(timeoutCallback);

  runner.complete(0, successfulResult("done"));
  await runner.flush();
  const result = await waiting;
  signal.abort();
  timeoutCallback();

  assert.equal(result.outcome, "completed");
  assert.equal(signal.removeCalls, 1);
  assert.equal(clock.timers.size, 0);
});

test("waitFor an already-aborted signal resolves without retaining resources", async () => {
  const clock = new WaitClock();
  const signal = new TrackedAbortSignal();
  signal.abort();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  const result = await manager.waitFor({ ids: [job.id], until: "all", timeoutMs: 100, signal: signal as AbortSignal });

  assert.equal(result.outcome, "aborted");
  assert.equal(clock.timers.size, 0);
  assert.equal(runner.started[0]?.cancelCalls, 0);
});
```

- [ ] **Step 4: Run lifecycle tests and verify RED**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="waitFor times out|waitFor aborts|waitFor completion wins|already-aborted"
```

Expected: FAIL because pending waits do not install a timeout or abort listener.

- [ ] **Step 5: Unify all exits through one cleanup-before-resolve callback**

Replace Task 2's pending-promise body with this implementation:

```typescript
return new Promise<WaitResult>((resolve) => {
  let settled = false;
  let timer: unknown;
  let unsubscribe: (() => void) | undefined;
  let settle!: (outcome: WaitOutcome) => void;
  const onAbort = () => settle("aborted");

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (timer !== undefined) this.clearTimer(timer);
    timer = undefined;
    options.signal?.removeEventListener("abort", onAbort);
  };

  settle = (outcome) => {
    if (settled) return;
    const current = this.waitSnapshots(options.ids);
    if (outcome === "completed" && !this.waitSatisfied(current, options.until)) return;
    settled = true;
    cleanup();
    resolve({
      operation: "wait",
      outcome,
      until: options.until,
      timeoutMs: options.timeoutMs,
      elapsedMs: this.now() - startedAt,
      jobs: current,
    });
  };

  unsubscribe = this.subscribe(() => settle("completed"));
  if (settled) {
    unsubscribe();
    return;
  }
  if (options.signal?.aborted) {
    settle("aborted");
    return;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (settled) return;
  timer = this.setTimer(() => settle("timed_out"), options.timeoutMs);
  if (settled && timer !== undefined) this.clearTimer(timer);
});
```

Because `settle()` is declared as a closure before any callback can invoke `onAbort`, this remains safe under synchronous subscription setup. Cleanup happens before `resolve()`, and neither timeout nor abort touches a job.

- [ ] **Step 6: Run lifecycle, manager, and type tests**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="waitFor"
npx tsx --test test/job-manager.test.ts
npm run typecheck
```

Expected: PASS, including completion/timeout and completion/abort race assertions.

- [ ] **Step 7: Commit bounded lifecycle handling**

```bash
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: bound and abort subagent waits"
```

---

### Task 4: Settle simultaneous waits deterministically on shutdown

**Files:**
- Modify: `src/job-manager.ts:30-38,152-177`
- Test: `test/job-manager.test.ts` (append concurrency/shutdown tests)

**Interfaces:**
- Consumes: Task 3's guarded `settle("aborted")` path.
- Produces: manager-owned `private readonly waiters = new Set<() => void>()`.
- `shutdown()` invokes every registered waiter before its existing queued/running cancellation loops.

- [ ] **Step 1: Write failing simultaneous-waiter and shutdown tests**

Append:

```typescript
test("multiple simultaneous waiters settle independently", async () => {
  const clock = new WaitClock();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 2, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const [first, second] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(first && second);

  const any = manager.waitFor({ ids: [first.id, second.id], until: "any", timeoutMs: 30_000 });
  const all = manager.waitFor({ ids: [first.id, second.id], until: "all", timeoutMs: 30_000 });
  runner.complete(0, successfulResult("first"));
  await runner.flush();
  assert.equal((await any).outcome, "completed");
  assert.equal(clock.timers.size, 1);

  runner.complete(1, successfulResult("second"));
  await runner.flush();
  assert.equal((await all).outcome, "completed");
  assert.equal(clock.timers.size, 0);
});

test("shutdown aborts waiters before cancelling jobs and clears their resources", async () => {
  const clock = new WaitClock();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const [running, queued] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(running && queued);
  const observed: Array<[string, string]> = [];
  const waiting = manager.waitFor({ ids: [running.id, queued.id], until: "all", timeoutMs: 30_000 }).then((result) => {
    observed.push(...result.jobs.map((job) => [job.id, job.state] as [string, string]));
    return result;
  });

  const stopping = manager.shutdown();
  const result = await waiting;
  assert.equal(result.outcome, "aborted");
  assert.deepEqual(observed, [[running.id, "running"], [queued.id, "queued"]]);
  assert.equal(manager.get(queued.id)?.state, "cancelled");
  assert.equal(clock.timers.size, 0);

  runner.releaseCancel(0);
  runner.complete(0, successfulResult("late"));
  await stopping;
});

test("a throwing manager subscriber cannot strand a waiter", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  manager.subscribe(() => { throw new Error("listener failed"); });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  const waiting = manager.waitFor({ ids: [job.id], until: "all", timeoutMs: 30_000 });
  runner.complete(0, successfulResult("done"));
  await runner.flush();

  assert.equal((await waiting).outcome, "completed");
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="multiple simultaneous waiters|shutdown aborts waiters|throwing manager subscriber"
```

Expected: the shutdown test FAILS because shutdown currently leaves the wait pending until cancellation notifications; the other tests protect independent subscriptions and listener isolation.

- [ ] **Step 3: Register each pending wait with the manager**

Add the field:

```typescript
private readonly waiters = new Set<() => void>();
```

Inside the pending promise, add this declaration beside `let settle!` so cleanup can always reference it safely:

```typescript
let abortForShutdown!: () => void;
```

Add this removal as the first operation in `cleanup()`:

```typescript
this.waiters.delete(abortForShutdown);
```

Immediately after assigning the `settle` closure and before calling `subscribe()`, initialize and register the callback:

```typescript
abortForShutdown = () => settle("aborted");
this.waiters.add(abortForShutdown);
```

The callback belongs only to one wait and uses the same exactly-once settlement path as signal abort.

- [ ] **Step 4: Abort registered waiters before existing shutdown cancellation**

Immediately after `this.stopped = true` in `shutdown()` add:

```typescript
for (const abortWaiter of [...this.waiters]) abortWaiter();
```

Keep this before the queue, active, and starting cancellation loops. Do not await wait promises and do not route this through `cancel()`.

- [ ] **Step 5: Run complete manager verification**

Run:

```bash
npx tsx --test test/job-manager.test.ts
npm run typecheck
```

Expected: PASS, with shutdown wait snapshots showing pre-cancellation `running`/`queued` states and existing shutdown cancellation tests unchanged.

- [ ] **Step 6: Commit manager shutdown integration**

```bash
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: settle subagent waits during shutdown"
```

---

### Task 5: Add the wait schema and state-only tool execution

**Files:**
- Modify: `src/tools.ts:1-68,76-120`
- Test: `test/tools.test.ts:1-65` and append wait execution tests

**Interfaces:**
- Consumes: `JobManager.waitFor()`, `WaitResult`, and `WaitJobStatus` from Tasks 1–4.
- Produces: `WaitParams`, `WaitInput`, `WaitToolDetails`, and `waitJobs(input, services, signal?)`.
- Successful wait details are exactly `WaitResult`; diagnostic details use the existing `{ jobs: [], diagnostics, operation: "wait" }` shape.

- [ ] **Step 1: Write failing schema and execution tests**

Add `WaitParams` and `waitJobs` to the `src/tools.ts` test import and add this validator import:

```typescript
import { Check } from "typebox/value";
```

Then append:

```typescript
test("wait schema bounds IDs, condition, and timeout", () => {
  const schema = WaitParams as unknown as {
    properties: {
      ids: { minItems: number; maxItems: number };
      until: { enum: string[]; default: string };
      timeoutMs: { type: string; minimum: number; maximum: number; default: number };
    };
  };

  assert.equal(schema.properties.ids.minItems, 1);
  assert.equal(schema.properties.ids.maxItems, 8);
  assert.deepEqual(schema.properties.until.enum, ["any", "all"]);
  assert.equal(schema.properties.until.default, "all");
  assert.equal(schema.properties.timeoutMs.type, "integer");
  assert.equal(schema.properties.timeoutMs.minimum, 100);
  assert.equal(schema.properties.timeoutMs.maximum, 30_000);
  assert.equal(schema.properties.timeoutMs.default, 15_000);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 100 }), true);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 30_000 }), true);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 99 }), false);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 30_001 }), false);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 100.5 }), false);
});

test("waitJobs applies defaults and returns only state snapshots", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "secret task" }] }, services, {} as never);
  runner.started[0]?.resolve(completed("secret output"));
  await runner.flush();

  const result = await waitJobs({ ids: ["job-1"] }, services);

  assert.equal(text(result), "Wait completed: job-1 (completed).");
  assert.ok("outcome" in result.details);
  assert.deepEqual(result.details, {
    operation: "wait",
    outcome: "completed",
    until: "all",
    timeoutMs: 15_000,
    elapsedMs: result.details.elapsedMs,
    jobs: [{ id: "job-1", state: "completed" }],
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret task|secret output|progress|stderr|profile|usage/);
});

test("waitJobs returns atomic diagnostics for duplicate and unknown IDs", async () => {
  const { services } = createServices();
  await startJobs({ tasks: [{ task: "one" }] }, services, {} as never);

  const duplicate = await waitJobs({ ids: ["job-1", "job-1"] }, services);
  const unknown = await waitJobs({ ids: ["job-1", "missing"] }, services);

  assert.equal(text(duplicate), "Duplicate job ID: job-1");
  assert.deepEqual(duplicate.details, {
    jobs: [],
    diagnostics: ["Duplicate job ID: job-1"],
    operation: "wait",
  });
  assert.equal(text(unknown), "Unknown job: missing");
  assert.deepEqual(unknown.details, {
    jobs: [],
    diagnostics: ["Unknown job: missing"],
    operation: "wait",
  });
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx tsx --test test/tools.test.ts --test-name-pattern="wait schema|waitJobs"
```

Expected: FAIL because `WaitParams` and `waitJobs` are not exported.

- [ ] **Step 3: Define schema, input, and details unions**

In `src/tools.ts`, import the manager wait types and add:

```typescript
import { JobManager, type WaitJobStatus, type WaitResult, type WaitUntil } from "./job-manager.js";

export const WaitParams = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  until: Type.Optional(StringEnum(["any", "all"] as const, { default: "all" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 100, maximum: 30_000, default: 15_000 })),
});

export type WaitInput = Static<typeof WaitParams>;

export interface ToolDetails {
  jobs: Job[];
  diagnostics: string[];
  operation?: "start" | "status" | "wait" | "cancel" | "collect" | "discard";
}

export type WaitToolDetails = WaitResult;

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails | WaitToolDetails;
}
```

Keep the existing `response()` helper returning `ToolDetails`; wait success uses a direct response so full `Job` objects cannot leak.

- [ ] **Step 4: Implement wait execution and exact model-visible text**

Add below `statusJobs()`:

```typescript
const waitSummary = (jobs: readonly WaitJobStatus[]): string =>
  jobs.map((job) => `${job.id} (${job.state})`).join(", ");

const expectedWaitDiagnostic = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  return /^(Unknown job|Duplicate job ID): /.test(error.message) ? error.message : undefined;
};

export async function waitJobs(
  input: WaitInput,
  services: ToolServices,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  const until: WaitUntil = input.until ?? "all";
  const timeoutMs = input.timeoutMs ?? 15_000;
  let result: WaitResult;
  try {
    result = await services.manager.waitFor({ ids: input.ids, until, timeoutMs, signal });
  } catch (error) {
    const diagnostic = expectedWaitDiagnostic(error);
    if (!diagnostic) throw error;
    return response(diagnostic, [], [diagnostic], "wait");
  }

  const jobs = waitSummary(result.jobs);
  const content = result.outcome === "completed"
    ? `Wait completed: ${jobs}.`
    : result.outcome === "timed_out"
      ? `Wait timed out after ${timeoutMs} ms: ${jobs}.\nDo not wait again immediately; continue other work or return control.`
      : `Wait aborted: ${jobs}.`;
  return { content: [{ type: "text", text: content }], details: result };
}
```

Do not include collected output in `content` or `details`. Do not catch timeout or abort because they are normal resolved outcomes.

- [ ] **Step 5: Add timeout and aborted formatting assertions**

Use a small manager-shaped stub so this test remains a tool-format test:

```typescript
test("waitJobs formats timeout guidance and compact abort text", async () => {
  const timedOutManager = {
    waitFor: async () => ({
      operation: "wait" as const,
      outcome: "timed_out" as const,
      until: "any" as const,
      timeoutMs: 100,
      elapsedMs: 100,
      jobs: [{ id: "job-1", state: "running" as const }],
    }),
  } as unknown as JobManager;
  const timedOut = await waitJobs(
    { ids: ["job-1"], until: "any", timeoutMs: 100 },
    { manager: timedOutManager } as ToolServices,
  );
  assert.equal(
    text(timedOut),
    "Wait timed out after 100 ms: job-1 (running).\nDo not wait again immediately; continue other work or return control.",
  );

  const abortedManager = {
    waitFor: async () => ({
      operation: "wait" as const,
      outcome: "aborted" as const,
      until: "all" as const,
      timeoutMs: 30_000,
      elapsedMs: 5,
      jobs: [{ id: "job-1", state: "running" as const }],
    }),
  } as unknown as JobManager;
  const aborted = await waitJobs(
    { ids: ["job-1"], timeoutMs: 30_000 },
    { manager: abortedManager } as ToolServices,
  );
  assert.equal(text(aborted), "Wait aborted: job-1 (running).");
});
```

- [ ] **Step 6: Run tool tests and typecheck**

Run:

```bash
npx tsx --test test/tools.test.ts --test-name-pattern="wait schema|waitJobs"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit the wait tool contract**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: add subagent wait tool contract"
```

---

### Task 6: Register, abort, and render `subagent_wait`

**Files:**
- Modify: `src/tools.ts:125-215`
- Test: `test/tools.test.ts` (extend `FakePi` registration tests and renderer coverage)

**Interfaces:**
- Consumes: `WaitParams`, `waitJobs()`, and `WaitToolDetails` from Task 5.
- Produces: registered `subagent_wait` with Pi's `execute(_id, input, signal)` signal forwarded unchanged.
- Compact rendering shows outcome and states; expanded rendering additionally shows `until`, configured timeout, and elapsed duration.

- [ ] **Step 1: Write failing registration and parent-signal abort tests**

Append:

```typescript
test("registered subagent_wait forwards the parent tool signal without cancelling jobs", async () => {
  const pi = new FakePi();
  const { services, runner } = createServices();
  registerSubagentTools(pi as never, services);
  await startJobs({ tasks: [{ task: "keep running" }] }, services, {} as never);
  const controller = new AbortController();
  const wait = pi.tools.get("subagent_wait");
  assert.ok(wait);

  const executing = wait.execute(
    "call",
    { ids: ["job-1"], until: "all", timeoutMs: 30_000 },
    controller.signal,
    undefined,
    {} as never,
  );
  controller.abort();
  const result = await executing;

  assert.equal(result.details.outcome, "aborted");
  assert.equal(services.manager.get("job-1")?.state, "running");
  assert.equal(runner.started[0]?.cancelled, 0);
});

test("subagent_wait description limits use to one short near-completion wait", () => {
  const pi = new FakePi();
  const { services } = createServices();
  registerSubagentTools(pi as never, services);

  const description = pi.tools.get("subagent_wait")?.description ?? "";
  assert.match(description, /expected to finish soon/i);
  assert.match(description, /no useful parent work/i);
  assert.match(description, /at most 30 seconds/i);
  assert.match(description, /do not.*again immediately/i);
});
```

- [ ] **Step 2: Write failing compact and expanded renderer tests**

Append:

```typescript
test("subagent_wait renderer shows state-only compact and expanded details", () => {
  const pi = new FakePi();
  const { services } = createServices();
  registerSubagentTools(pi as never, services);
  const theme = { fg: (_color: string, value: string) => value };
  const details = {
    operation: "wait" as const,
    outcome: "timed_out" as const,
    until: "all" as const,
    timeoutMs: 15_000,
    elapsedMs: 15_003,
    jobs: [
      { id: "job-1", state: "running" as const },
      { id: "job-2", state: "completed" as const },
    ],
  };
  const result = {
    content: [{ type: "text" as const, text: "Wait timed out after 15000 ms: job-1 (running), job-2 (completed)." }],
    details,
  };
  const renderer = pi.tools.get("subagent_wait")?.renderResult;
  const compact = renderer(result, { expanded: false }, theme).render(160).join("\n");
  const expanded = renderer(result, { expanded: true }, theme).render(160).join("\n");

  assert.match(compact, /Wait timed out/);
  assert.match(compact, /… job-1 running/);
  assert.match(compact, /✓ job-2 completed/);
  assert.doesNotMatch(compact, /Condition|Configured timeout|Elapsed/);
  assert.match(expanded, /Condition: all/);
  assert.match(expanded, /Configured timeout: 15000 ms/);
  assert.match(expanded, /Elapsed: 15003 ms/);
  assert.doesNotMatch(expanded, /output|stderr|task|profile|usage/i);
});
```

- [ ] **Step 3: Run registration and rendering tests and verify RED**

Run:

```bash
npx tsx --test test/tools.test.ts --test-name-pattern="registered subagent_wait|subagent_wait description|subagent_wait renderer"
```

Expected: FAIL because `subagent_wait` is not registered.

- [ ] **Step 4: Narrow wait rendering before the existing full-job renderer**

At the start of `renderToolResult()`, detect exact wait details:

```typescript
const renderWaitResult = (
  result: ToolResponse,
  expanded: boolean,
  theme: { fg(color: string, text: string): string },
): string => {
  if (!("outcome" in result.details)) return "";
  const { outcome, jobs, until, timeoutMs, elapsedMs } = result.details;
  const label = outcome === "completed" ? "Wait completed" : outcome === "timed_out" ? "Wait timed out" : "Wait aborted";
  const compact = [label, ...jobs.map((job) => `${iconForState(job.state)} ${job.id} ${job.state}`)].join("\n");
  const detail = expanded
    ? `Condition: ${until}\nConfigured timeout: ${timeoutMs} ms\nElapsed: ${elapsedMs} ms`
    : "";
  return theme.fg("muted", [compact, detail].filter(Boolean).join("\n\n"));
};
```

Replace the existing state-icon closure with this module-level function so both renderers use exactly the same icons:

```typescript
const iconForState = (state: Job["state"]): string => {
  if (state === "completed") return "✓";
  if (state === "failed" || state === "cancelled") return "✗";
  if (state === "collected") return "↳";
  if (state === "discarded") return "⌫";
  return state === "queued" ? "○" : "…";
};
```

In `renderToolResult()`, return `renderWaitResult(...)` when `"outcome" in result.details`; only then destructure the standard `jobs`, `diagnostics`, and `operation` fields. Replace each old `icon(job.state)` call with `iconForState(job.state)`.

- [ ] **Step 5: Register the separate wait tool and forward Pi's signal**

Add this registration between status and control:

```typescript
pi.registerTool({
  name: "subagent_wait",
  label: "Wait for Subagents",
  description: [
    "Wait once for requested jobs only when they are expected to finish soon and no useful parent work can proceed meanwhile.",
    "The wait lasts at most 30 seconds and returns current states without collecting output or cancelling jobs.",
    "After a timeout, do not call subagent_wait again immediately; continue other work or return control.",
  ].join(" "),
  parameters: WaitParams,
  execute: async (_id, input, signal) => waitJobs(input, services, signal),
  renderCall: (input, theme) => new Text(
    theme.fg("toolTitle", `subagent_wait ${input.until ?? "all"} ${input.ids.join(", ")}`),
    0,
    0,
  ),
  renderResult: (result, { expanded }, theme) => new Text(
    renderToolResult(result as ToolResponse, expanded, theme),
    0,
    0,
  ),
});
```

Do not hide waiting inside `subagent_status`.

- [ ] **Step 6: Extend the strict registered-tool assertion**

In the existing `registered tools expose strict schema boundaries and required guidance` test, keep shared start/status/control guidance checks on those three names only. Add separate assertions for `subagent_wait`:

```typescript
assert.ok(pi.tools.get("subagent_wait"));
assert.equal(pi.tools.get("subagent_wait")?.parameters, WaitParams);
assert.match(pi.tools.get("subagent_wait")?.description ?? "", /at most 30 seconds/i);
```

This avoids incorrectly requiring start/collection copy in the dedicated wait description.

- [ ] **Step 7: Run the complete tool suite and typecheck**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: PASS, including tool-boundary abort with the child still `running` and zero runner cancellation calls.

- [ ] **Step 8: Commit registration and rendering**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: register and render subagent waits"
```

---

### Task 7: Document bounded parent-session responsiveness

**Files:**
- Modify: `README.md:9-15,52-57`
- Test: `test/package.test.ts`

**Interfaces:**
- Consumes: the public `subagent_wait` behavior from Tasks 5–6.
- Produces: user-facing lifecycle guidance with the exact 30-second cap, parent concurrency limitation, abort guarantee, and retry advice.

- [ ] **Step 1: Write the failing README contract test**

Append to `test/package.test.ts`:

```typescript
test("README documents bounded subagent waits and parent responsiveness", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /subagent_wait/);
  assert.match(readme, /parent cannot answer concurrently/i);
  assert.match(readme, /at most 30 seconds/i);
  assert.match(readme, /aborting the parent turn does not cancel subagents/i);
  assert.match(readme, /do not immediately wait again/i);
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```bash
npx tsx --test test/package.test.ts --test-name-pattern="bounded subagent waits"
```

Expected: FAIL because the README does not mention `subagent_wait` or its responsiveness constraints.

- [ ] **Step 3: Add one usage example and the lifecycle guidance**

Extend the natural-language examples in `README.md` with “wait for job-1 and job-3.” Add this paragraph under `## Limits and lifecycle`:

```markdown
`subagent_wait` is a short, event-driven pause for jobs expected to finish soon when no useful parent work can proceed. The parent cannot answer concurrently while the tool is waiting, so each call defaults to 15 seconds and lasts at most 30 seconds. A timeout returns current states without cancelling work; do not immediately wait again—continue other work or return control. Aborting the parent turn does not cancel subagents.
```

Keep the existing memory-only, cancellation, collection, and session shutdown text unchanged.

- [ ] **Step 4: Run documentation and full verification**

Run:

```bash
npx tsx --test test/package.test.ts
npm run typecheck
npm run test:unit
npm test
```

Expected: PASS. The full suite verifies manager lifecycle, tool behavior, dashboard/notifier regressions, package metadata, and integration behavior.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md test/package.test.ts
git commit -m "docs: explain bounded subagent waits"
```

---

## Final Verification

- [ ] Run the exact release checks from a clean working tree:

```bash
npm run typecheck
npm run test:unit
npm test
git status --short
```

Expected: all commands PASS and `git status --short` prints nothing.

- [ ] Inspect the focused diff for accidental result leakage or cancellation calls:

```bash
git diff HEAD~7 -- src/job-manager.ts src/tools.ts README.md test/job-manager.test.ts test/tools.test.ts test/package.test.ts
grep -n "cancel(" src/job-manager.ts src/tools.ts
grep -nE "output|stderr|progress|task|profile|usage" src/tools.ts
```

Expected: wait timeout/abort paths contain no `cancel()` call; any output-related matches belong only to existing start/status/control code, while wait success details remain `WaitResult` state snapshots.

- [ ] Confirm every Spec 02 behavior is represented by a named test:

```bash
npx tsx --test test/job-manager.test.ts test/tools.test.ts test/package.test.ts --test-name-pattern="wait|Wait|README"
```

Expected: PASS for validation, immediate satisfaction, `any`, `all`, settled states, timeout, abort, races, simultaneous waiters, shutdown ordering, cleanup, schema bounds/defaults, signal forwarding, state-only details, rendering, guidance, and documentation.
