# Job Lifecycle Policy Design

## Summary

Concentrate repeated job-state meaning in one pure `job-lifecycle` module while preserving every observable behavior. Tools, status, dashboard, and `JobManager` will consume the same lifecycle facts and control decisions instead of maintaining separate state lists.

This is an in-process deepening. It adds no I/O, dependency, port, or adapter.

## Goals

- Give job-state meaning one implementation.
- Preserve all existing state transitions and race behavior.
- Preserve exact tool diagnostics and mixed-ID processing.
- Preserve dashboard visibility, grouping, counts, and cancellation behavior.
- Preserve status ordering, timing, and result-ready behavior.
- Preserve the public `isSettled` export and its truth table.
- Test lifecycle policy through one interface.

## Non-goals

- Adding or removing job states.
- Changing cancellation settlement.
- Adding continuation, generations, collect-ready, or timeouts.
- Replacing `JobManager` with a generic state machine.
- Moving timers, process execution, queue pumping, mutation, notifications, or output capture into the lifecycle module.
- Changing user-visible text, ordering, or tool schemas.

## Current friction

The same state sets are reconstructed in several modules:

- `types.ts` defines settled states.
- `job-manager.ts` separately defines terminal and inbox states.
- `tools.ts` separately defines valid cancel, collect, and discard states.
- `job-status.ts` separately defines terminal, result-ready, and status-order groups.
- `dashboard.ts` separately defines inbox visibility, ready counts, and cancellation eligibility.

A new state or lifecycle change could therefore make these callers disagree. The deletion test supports deepening: without one lifecycle module, the same seven-state policy immediately reappears across all five callers.

## Module and seam

Create `src/job-lifecycle.ts`. Its external interface has two main entry points:

```ts
import type { JobState } from "./types.js";

export type JobControlAction = "cancel" | "collect" | "discard";

export interface JobLifecycleFacts {
  readonly settled: boolean;
  readonly inbox: boolean;
}

export type JobControlDecision =
  | {
      readonly kind: "apply";
      readonly nextState: JobState;
    }
  | {
      readonly kind: "already-applied";
      readonly nextState: JobState;
    }
  | {
      readonly kind: "invalid";
      readonly message: string;
    };

export function inspectJobState(state: JobState): JobLifecycleFacts;

export function decideJobControl(
  state: JobState,
  action: JobControlAction,
): JobControlDecision;
```

The interface is small:

- `inspectJobState` answers stable semantic facts.
- `decideJobControl` owns control eligibility, idempotence, next state, and existing invalid-action wording.

The implementation hides one exhaustive state table. Callers do not know its shape.

## State facts

`inspectJobState` is total, pure, and deterministic.

| State | `settled` | `inbox` |
| --- | ---: | ---: |
| `queued` | false | false |
| `running` | false | false |
| `completed` | true | true |
| `failed` | true | true |
| `cancelled` | true | true |
| `collected` | true | false |
| `discarded` | true | false |

Callers derive their existing behavior from these facts:

- Result-ready means `inbox`.
- Dashboard-ready means `inbox`.
- Dashboard visibility includes queued, running, and `inbox` states.
- Status ordering is unsettled first, then `inbox`, then other settled history.
- Duration projection uses `settled` where it currently uses a terminal-state list.

Queued and running remain distinct concrete states. The lifecycle module does not invent a new domain state.

## Control decisions

`decideJobControl` is total, pure, and deterministic.

| Current state | Action | Decision |
| --- | --- | --- |
| `queued` | cancel | apply `cancelled` |
| `running` | cancel | apply `cancelled` |
| `cancelled` | cancel | already applied as `cancelled` |
| `completed` | collect | apply `collected` |
| `failed` | collect | apply `collected` |
| `cancelled` | collect | apply `collected` |
| `collected` | collect | already applied as `collected` |
| `completed` | discard | apply `discarded` |
| `failed` | discard | apply `discarded` |
| `cancelled` | discard | apply `discarded` |
| `discarded` | discard | already applied as `discarded` |
| every other pair | any | invalid |

Invalid decisions use the current exact wording:

```text
Cannot <action> job in <state> state
```

Unknown job IDs remain outside this module because they depend on manager storage rather than lifecycle meaning.

## Caller behavior

### `types.ts`

Keep `JobState` in `types.ts`. Preserve the existing public import path by implementing `isSettled` in terms of `inspectJobState` or re-exporting a compatibility function from the lifecycle module.

`job-lifecycle.ts` imports `JobState` as a type only, so it introduces no runtime dependency cycle.

### `job-manager.ts`

Use lifecycle facts and decisions for:

- Terminal cancellation short-circuiting.
- Collect validation and idempotence.
- Discard validation and idempotence.
- Inbox-state checks.
- Wait settlement through the existing `isSettled` compatibility export.

Keep these concerns inside `JobManager`:

- Starting and finishing timestamps.
- Cancellation requests and promises.
- Active and starting process reservations.
- Queue capacity and pumping.
- Late progress behavior.
- Process result classification.
- State mutation, snapshots, subscriptions, and notifications.

The new module must not alter cancellation or result races.

### `tools.ts`

Replace action-specific state arrays with `decideJobControl`.

Continue processing IDs sequentially. For each ID:

1. Report an unknown-ID diagnostic when absent.
2. Report the lifecycle decision's exact diagnostic when invalid.
3. Invoke the existing manager operation when the decision is `apply` or `already-applied`.

Invoking the manager for `already-applied` decisions preserves existing returned-job details and collected-output behavior.

### `job-status.ts`

Use lifecycle facts for:

- Terminal duration handling.
- Result-ready status.
- Aggregate status ordering.

Keep status formatting, error detection, activity projection, and capture notices unchanged.

### `dashboard.ts`

Use lifecycle facts for:

- Inbox visibility.
- Ready attention counts.
- Inbox grouping.

Use `decideJobControl(state, "cancel")` to keep the cancel key active only for an `apply` decision. A cancelled job remains idempotently cancellable through tools and `JobManager`, but the dashboard continues ignoring the cancel key for it exactly as today.

Keep rendering, selection, keyboard handling, subscriptions, and viewport behavior unchanged.

## Error handling

- `inspectJobState` accepts every `JobState`; there is no error result.
- `decideJobControl` accepts every `JobState` and `JobControlAction`; invalid combinations return a decision rather than throwing.
- `JobManager.collect` and `JobManager.discard` continue throwing the same error text for invalid direct calls.
- Tools continue returning diagnostics instead of throwing for invalid control requests.
- Unknown IDs retain their current diagnostics and manager errors.

## Testing strategy

Follow test-driven development.

### Lifecycle interface tests

Add `test/job-lifecycle.test.ts` with table-driven coverage for:

- Both lifecycle facts for all seven states.
- Every state × action pair.
- Exact next states.
- Idempotent decisions.
- Exact invalid-action messages.

The first test run must fail because the lifecycle module does not yet exist. Implement the smallest table needed to make these tests pass.

### Caller migration tests

Migrate one caller at a time and run its existing tests after each change:

1. `types.ts` and `job-manager.ts` with `test/job-manager.test.ts`.
2. `tools.ts` with `test/tools.test.ts`.
3. `job-status.ts` with `test/job-status.test.ts`.
4. `dashboard.ts` with `test/dashboard.test.ts`.

Existing tests remain the behavior-preservation surface. Do not replace them with implementation-level assertions.

### Final verification

Run:

```sh
npm test
npm run typecheck
```

Then run diagnostics for all edited TypeScript files.

## Risks and controls

### Risk: tool behavior changes for idempotent actions

Control: tools invoke the manager for both `apply` and `already-applied` decisions.

### Risk: dashboard starts cancelling already-cancelled jobs

Control: dashboard enables cancellation only for `kind === "apply"`.

### Risk: process races move into the lifecycle module

Control: the module remains pure and owns no promises, timers, mutations, process handles, or callbacks.

### Risk: a new state is incompletely defined

Control: the implementation uses an exhaustive table checked against `Record<JobState, ...>`, and tests cover every state × action pair.

## Success criteria

- One module owns settled, inbox, and control-action state knowledge.
- No duplicated control eligibility arrays remain in tools.
- No duplicated terminal or inbox state lists remain in status or dashboard.
- Existing observable behavior and text remain unchanged.
- Existing race, manager, tool, status, and dashboard tests pass unchanged.
- The new lifecycle interface has exhaustive table-driven tests.
- No new dependency or adapter is introduced.
