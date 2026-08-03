# Job Lifecycle Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize job-state facts and control decisions in one pure module without changing any observable behavior.

**Architecture:** Add a deep in-process `job-lifecycle` module with two entry points: inspect a state and decide a control action. Migrate `JobManager`, tools, status, and dashboard to this seam while leaving mutation, process timing, rendering, and output handling in their current modules.

**Tech Stack:** TypeScript 5.9, Node.js 22, `node:test`, `tsx`

## Global Constraints

- Preserve every existing state transition, diagnostic, ordering rule, dashboard result, and race behavior.
- Keep `JobState` and the public `isSettled` export in `src/types.ts`.
- Add no dependency, I/O, port, or adapter.
- Keep timers, process execution, queue pumping, mutation, notifications, and output capture outside the lifecycle module.
- Continue processing mixed control IDs sequentially; invalid IDs or transitions must not stop valid IDs.
- Tools must invoke the manager for both new and already-applied decisions.
- Dashboard cancellation must remain active only for queued and running jobs.

---

### Task 1: Add the deep lifecycle module through TDD

**Files:**

- Create: `src/job-lifecycle.ts`
- Create: `test/job-lifecycle.test.ts`
- Modify: `src/types.ts:79-80`

**Interfaces:**

- Produces: `inspectJobState(state: JobState): JobLifecycleFacts`
- Produces: `decideJobControl(state: JobState, action: JobControlAction): JobControlDecision`
- Preserves: `isSettled(state: JobState): boolean` from `src/types.ts`

- [ ] **Step 1: Write the failing lifecycle interface tests**

Create `test/job-lifecycle.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { JobState } from "../src/types.js";

const states: JobState[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "collected",
  "discarded",
];

const loadLifecycle = async () => {
  try {
    return await import("../src/job-lifecycle.js");
  } catch (error) {
    assert.fail(`job lifecycle module is unavailable: ${String(error)}`);
  }
};

test("inspects settled and inbox facts for every job state", async () => {
  const { inspectJobState } = await loadLifecycle();
  const expected = {
    queued: { settled: false, inbox: false },
    running: { settled: false, inbox: false },
    completed: { settled: true, inbox: true },
    failed: { settled: true, inbox: true },
    cancelled: { settled: true, inbox: true },
    collected: { settled: true, inbox: false },
    discarded: { settled: true, inbox: false },
  } as const;

  for (const state of states) assert.deepEqual(inspectJobState(state), expected[state]);
});

test("decides every valid and idempotent control action", async () => {
  const { decideJobControl } = await loadLifecycle();
  const expected = [
    ["queued", "cancel", { kind: "apply", nextState: "cancelled" }],
    ["running", "cancel", { kind: "apply", nextState: "cancelled" }],
    ["cancelled", "cancel", { kind: "already-applied", nextState: "cancelled" }],
    ["completed", "collect", { kind: "apply", nextState: "collected" }],
    ["failed", "collect", { kind: "apply", nextState: "collected" }],
    ["cancelled", "collect", { kind: "apply", nextState: "collected" }],
    ["collected", "collect", { kind: "already-applied", nextState: "collected" }],
    ["completed", "discard", { kind: "apply", nextState: "discarded" }],
    ["failed", "discard", { kind: "apply", nextState: "discarded" }],
    ["cancelled", "discard", { kind: "apply", nextState: "discarded" }],
    ["discarded", "discard", { kind: "already-applied", nextState: "discarded" }],
  ] as const;

  for (const [state, action, decision] of expected) {
    assert.deepEqual(decideJobControl(state, action), decision);
  }
});

test("returns the existing diagnostic for every invalid control action", async () => {
  const { decideJobControl } = await loadLifecycle();
  const actions = ["cancel", "collect", "discard"] as const;
  const valid = new Set([
    "queued:cancel",
    "running:cancel",
    "cancelled:cancel",
    "completed:collect",
    "failed:collect",
    "cancelled:collect",
    "collected:collect",
    "completed:discard",
    "failed:discard",
    "cancelled:discard",
    "discarded:discard",
  ]);

  for (const state of states) {
    for (const action of actions) {
      if (valid.has(`${state}:${action}`)) continue;
      assert.deepEqual(decideJobControl(state, action), {
        kind: "invalid",
        message: `Cannot ${action} job in ${state} state`,
      });
    }
  }
});
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```sh
npx tsx --test test/job-lifecycle.test.ts
```

Expected: FAIL in `loadLifecycle` with `job lifecycle module is unavailable` because `src/job-lifecycle.ts` does not exist.

- [ ] **Step 3: Implement the minimum exhaustive lifecycle table**

Create `src/job-lifecycle.ts`:

```ts
import type { JobState } from "./types.js";

export type JobControlAction = "cancel" | "collect" | "discard";

export interface JobLifecycleFacts {
  readonly settled: boolean;
  readonly inbox: boolean;
}

export type JobControlDecision =
  | { readonly kind: "apply"; readonly nextState: JobState }
  | { readonly kind: "already-applied"; readonly nextState: JobState }
  | { readonly kind: "invalid"; readonly message: string };

type ControlRule = JobState | "same";

type LifecycleRule = JobLifecycleFacts & {
  readonly controls: Readonly<Partial<Record<JobControlAction, ControlRule>>>;
};

const JOB_LIFECYCLE: Readonly<Record<JobState, LifecycleRule>> = {
  queued: { settled: false, inbox: false, controls: { cancel: "cancelled" } },
  running: { settled: false, inbox: false, controls: { cancel: "cancelled" } },
  completed: { settled: true, inbox: true, controls: { collect: "collected", discard: "discarded" } },
  failed: { settled: true, inbox: true, controls: { collect: "collected", discard: "discarded" } },
  cancelled: { settled: true, inbox: true, controls: { cancel: "same", collect: "collected", discard: "discarded" } },
  collected: { settled: true, inbox: false, controls: { collect: "same" } },
  discarded: { settled: true, inbox: false, controls: { discard: "same" } },
};

export function inspectJobState(state: JobState): JobLifecycleFacts {
  const { settled, inbox } = JOB_LIFECYCLE[state];
  return { settled, inbox };
}

export function decideJobControl(state: JobState, action: JobControlAction): JobControlDecision {
  const nextState = JOB_LIFECYCLE[state].controls[action];
  if (nextState === undefined) return { kind: "invalid", message: `Cannot ${action} job in ${state} state` };
  if (nextState === "same") return { kind: "already-applied", nextState: state };
  return { kind: "apply", nextState };
}
```

- [ ] **Step 4: Run the lifecycle test and verify GREEN**

Run:

```sh
npx tsx --test test/job-lifecycle.test.ts
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Preserve `isSettled` through the new interface**

In `src/types.ts`, add:

```ts
import { inspectJobState } from "./job-lifecycle.js";
```

Replace the existing `isSettled` implementation with:

```ts
export const isSettled = (state: JobState): boolean => inspectJobState(state).settled;
```

`job-lifecycle.ts` imports `JobState` as a type only, so this creates no runtime dependency cycle.

- [ ] **Step 6: Verify the lifecycle module, manager compatibility, and types**

Run:

```sh
npx tsx --test test/job-lifecycle.test.ts test/job-manager.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit the tested lifecycle interface**

```sh
git add src/job-lifecycle.ts src/types.ts test/job-lifecycle.test.ts
git commit -m "refactor: centralize job lifecycle policy"
```

---

### Task 2: Migrate manager and tool control decisions

**Files:**

- Modify: `src/job-manager.ts:1-5,148-188,486-492`
- Modify: `src/tools.ts:1-8,201-238`
- Test: `test/job-manager.test.ts`
- Test: `test/tools.test.ts`

**Interfaces:**

- Consumes: `inspectJobState(state)` from Task 1
- Consumes: `decideJobControl(state, action)` from Task 1
- Preserves: `JobManager.cancel`, `collect`, and `discard`
- Preserves: `controlJobs(input, services)`

- [ ] **Step 1: Establish the behavior-preservation baseline**

Run:

```sh
npx tsx --test test/job-manager.test.ts test/tools.test.ts
```

Expected: all existing manager and tool tests pass before caller migration.

- [ ] **Step 2: Migrate `JobManager.cancel` terminal inspection**

Add this import to `src/job-manager.ts`:

```ts
import { decideJobControl, inspectJobState } from "./job-lifecycle.js";
```

Replace:

```ts
if (this.isTerminal(entry.job.state)) return this.snapshot(entry.job);
```

with:

```ts
if (inspectJobState(entry.job.state).settled) return this.snapshot(entry.job);
```

Do not change the remaining cancellation implementation.

- [ ] **Step 3: Migrate collect and discard decisions**

Replace `JobManager.collect` with:

```ts
collect(id: string): Job {
  const entry = this.requireJob(id);
  const decision = decideJobControl(entry.job.state, "collect");
  if (decision.kind === "invalid") throw new Error(decision.message);
  if (decision.kind === "already-applied") return this.snapshot(entry.job);

  entry.job.state = decision.nextState;
  this.notify();
  return this.snapshot(entry.job);
}
```

Replace `JobManager.discard` with:

```ts
discard(id: string): Job {
  const entry = this.requireJob(id);
  const decision = decideJobControl(entry.job.state, "discard");
  if (decision.kind === "invalid") throw new Error(decision.message);
  if (decision.kind === "already-applied") return this.snapshot(entry.job);

  entry.job.state = decision.nextState;
  this.notify();
  return this.snapshot(entry.job);
}
```

Delete the now-unused private `isInboxState` and `isTerminal` methods. Keep `finish`, `addProgress`, cancellation settlement, and wait behavior unchanged.

- [ ] **Step 4: Verify manager behavior before changing tools**

Run:

```sh
npx tsx --test test/job-manager.test.ts
```

Expected: all manager tests pass, including cancellation races, idempotence, invalid cross-transitions, and wait settlement.

- [ ] **Step 5: Migrate tool prevalidation to the lifecycle decision**

Add this import to `src/tools.ts`:

```ts
import { decideJobControl } from "./job-lifecycle.js";
```

Inside the per-ID loop in `controlJobs`, replace the three action-specific state checks with:

```ts
const decision = decideJobControl(job.state, input.action);
if (decision.kind === "invalid") {
  diagnostics.push(decision.message);
  continue;
}
```

Leave the following operation dispatch unchanged:

```ts
if (input.action === "cancel") jobs.push(await services.manager.cancel(id));
else if (input.action === "discard") jobs.push(services.manager.discard(id));
else collected.push(job);
```

This preserves idempotent cancellation, collection formatting before mutation, sequential mixed-ID behavior, and manager revalidation.

- [ ] **Step 6: Verify tool and manager behavior together**

Run:

```sh
npx tsx --test test/job-manager.test.ts test/tools.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit the control caller migration**

```sh
git add src/job-manager.ts src/tools.ts
git commit -m "refactor: share lifecycle control decisions"
```

---

### Task 3: Migrate status and dashboard facts

**Files:**

- Modify: `src/job-status.ts:1-2,97-150`
- Modify: `src/dashboard.ts:1-23,134-164,213-222`
- Test: `test/job-status.test.ts`
- Test: `test/dashboard.test.ts`

**Interfaces:**

- Consumes: `inspectJobState(state)` from Task 1
- Consumes: `decideJobControl(state, "cancel")` from Task 1
- Preserves: status content, ordering, timing, dashboard grouping, attention counts, and keyboard behavior

- [ ] **Step 1: Establish the status and dashboard baseline**

Run:

```sh
npx tsx --test test/job-status.test.ts test/dashboard.test.ts
```

Expected: all existing status and dashboard tests pass before migration.

- [ ] **Step 2: Migrate status projection facts**

Add this import to `src/job-status.ts`:

```ts
import { inspectJobState } from "./job-lifecycle.js";
```

At the start of `projectJobStatus`, replace the local terminal-state expression with:

```ts
const lifecycle = inspectJobState(job.state);
```

Use `lifecycle.settled` in `queueEnd` and `runEnd`:

```ts
const queueEnd = job.state === "queued" ? now : job.startedAt ?? (lifecycle.settled ? job.finishedAt : undefined);
const runEnd = job.state === "running" ? now : lifecycle.settled ? job.finishedAt : undefined;
```

Replace `resultReady` with:

```ts
resultReady: lifecycle.inbox,
```

Leave error detection and every presentation field unchanged.

- [ ] **Step 3: Migrate aggregate status ordering**

Replace the local `group` implementation in `selectStatusList` with:

```ts
const group = (state: JobState): number => {
  const lifecycle = inspectJobState(state);
  return lifecycle.settled ? lifecycle.inbox ? 1 : 2 : 0;
};
```

Keep the stable index tie-breaker unchanged.

- [ ] **Step 4: Verify status behavior**

Run:

```sh
npx tsx --test test/job-status.test.ts
```

Expected: all status tests pass, including terminal queued duration, result-ready output, and active/inbox/history ordering.

- [ ] **Step 5: Migrate dashboard inbox facts and attention counts**

Add this import to `src/dashboard.ts`:

```ts
import { decideJobControl, inspectJobState } from "./job-lifecycle.js";
```

In `attentionCounts`, replace the ready-state array with:

```ts
else if (inspectJobState(job.state).inbox) counts.ready += 1;
```

Delete the local `isInbox` function.

In `records`, replace:

```ts
jobs.filter((job) => isInbox(job.state))
```

with:

```ts
jobs.filter((job) => inspectJobState(job.state).inbox)
```

Keep queued and running comparisons unchanged because they distinguish concrete dashboard sections rather than shared state sets.

- [ ] **Step 6: Migrate dashboard cancellation eligibility**

In `SubagentsDashboard.handleInput`, replace:

```ts
if (!selected || !matchesKey(data, "c") || (selected.state !== "queued" && selected.state !== "running")) return;
```

with:

```ts
if (!selected || !matchesKey(data, "c") || decideJobControl(selected.state, "cancel").kind !== "apply") return;
```

This deliberately excludes the `already-applied` cancelled decision and preserves current dashboard behavior.

- [ ] **Step 7: Verify dashboard and status behavior together**

Run:

```sh
npx tsx --test test/job-status.test.ts test/dashboard.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 8: Confirm duplicated lifecycle lists are gone**

Run:

```sh
rg -n '\["completed", "failed", "cancelled"\]|state === "completed" \|\| state === "failed" \|\| state === "cancelled"|\["queued", "running", "cancelled"\]|\["completed", "failed", "cancelled", "collected"\]|\["completed", "failed", "cancelled", "discarded"\]' src/types.ts src/job-manager.ts src/tools.ts src/job-status.ts src/dashboard.ts
```

Expected: no matches for duplicated lifecycle membership lists. Concrete state checks that control distinct queued/running execution behavior may remain.

- [ ] **Step 9: Run full verification**

Run:

```sh
npm test
npm run typecheck
```

Expected: the complete test suite passes with 0 failures and TypeScript exits 0.

Run LSP diagnostics on:

```text
src/job-lifecycle.ts
src/types.ts
src/job-manager.ts
src/tools.ts
src/job-status.ts
src/dashboard.ts
test/job-lifecycle.test.ts
```

Expected: no errors or warnings introduced by the edited files.

- [ ] **Step 10: Commit the lifecycle fact migration**

```sh
git add src/job-status.ts src/dashboard.ts
git commit -m "refactor: share lifecycle status facts"
```

---

## Plan self-review checklist

- The new interface matches the approved design specification.
- The lifecycle table is exhaustive over all seven current states.
- Every state × control action is tested.
- Exact invalid-action wording is tested.
- Idempotent tools still call the manager.
- Dashboard cancellation excludes already-cancelled jobs.
- Manager race-sensitive implementation remains untouched.
- Existing behavior tests remain in place.
- No new dependency or adapter is introduced.
