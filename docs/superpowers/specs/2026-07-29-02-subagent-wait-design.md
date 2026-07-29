# 02 — Bounded Subagent Wait Design

## Summary

Add a bounded `subagent_wait` tool so the parent can wait briefly for one or more jobs instead of repeatedly polling `subagent_status`. Waiting is deliberately short: 15 seconds by default and no more than 30 seconds. It never collects results, cancels jobs, or retains a long-running lock on the parent session.

This feature is independently releasable. It uses the existing `JobManager` subscription mechanism and does not depend on notification, discovery, model override, richer status, or terminology changes.

## Goals

- Replace rapid status polling with one short, event-driven wait.
- Support waiting for any or all requested jobs to settle.
- Limit parent-session unresponsiveness.
- Return normally on timeout with current process states.
- Ensure aborting the parent tool call stops the wait without cancelling any subagent job.
- Clean up every timer, subscription, and abort listener deterministically.

## Non-goals

- Waiting indefinitely.
- Collecting or discarding results.
- Cancelling subagents when a wait times out or is aborted.
- Scheduling, retries, dependencies, or workflow orchestration.
- Enforcing a cooldown between waits; avoiding immediate retry is model guidance rather than a stateful guarantee.
- Repeatedly waiting until a long-running job completes.
- Streaming child output into the wait result.

## Parent-session responsiveness

A custom tool occupies the parent agent’s current tool call until it returns. New user input may be queued, but the parent cannot answer it concurrently. The short timeout is therefore a product constraint rather than a configurable convenience.

- Default wait: `15_000` ms.
- Maximum wait: `30_000` ms.
- Minimum wait: `100` ms.

The tool description and timeout response explicitly instruct the parent not to call `subagent_wait` again immediately. This is advisory guidance, not an enforced cooldown. After a timeout, the parent should return control, do other useful work, or rely on the normal completion notification.

## Public interface

```ts
subagent_wait({
  ids: ["job-1", "job-2"],
  until: "any" | "all",
  timeoutMs: 15_000,
})
```

Schema rules:

- `ids` contains 1–8 strings.
- IDs must be unique; execution validates duplicates so it can return an actionable tool diagnostic.
- `until` is optional and defaults to `"all"`.
- `timeoutMs` is optional and defaults to `15_000`.
- `timeoutMs` must be an integer from 100 through 30,000.
- `StringEnum` is used for `until`.

Unknown IDs and duplicate IDs return a normal diagnostic tool result atomically before a waiter is installed. They do not throw an extension-level error.

## Settled states

The following satisfy a wait condition:

```text
completed, failed, cancelled, collected, discarded
```

A queued or running job does not satisfy it. Already-satisfied conditions return immediately without installing a timer.

For `until: "any"`, the wait ends when at least one requested job is settled. For `until: "all"`, every requested job must be settled.

## Results

A completed condition returns current snapshots for all requested IDs:

```text
Wait completed: job-1 (completed), job-2 (failed).
```

A timeout is a normal tool result:

```text
Wait timed out after 15000 ms: job-1 (running), job-2 (completed).
Do not wait again immediately; continue other work or return control.
```

If the parent turn is aborted—commonly by Escape in the TUI—the shared Pi abort signal may also affect sibling parent-tool work. The wait’s narrower guarantee is that its abort handler never calls `JobManager.cancel()` and therefore does not cancel subagent jobs. When Pi permits the tool result to finalize, it returns a compact aborted result and current states.

Tool details use state-only snapshots:

```ts
interface WaitJobStatus {
  id: string;
  state: JobState;
}

{
  operation: "wait";
  outcome: "completed" | "timed_out" | "aborted";
  until: "any" | "all";
  timeoutMs: number;
  elapsedMs: number;
  jobs: WaitJobStatus[];
}
```

Final output, stderr, progress, tasks, and profile internals are absent from both model-visible content and wait details.

## JobManager architecture

Add an asynchronous `waitFor()` operation to `JobManager`. It accepts IDs, the condition, timeout, and optional `AbortSignal`.

The operation:

1. Validates all IDs and uniqueness before side effects.
2. Evaluates current snapshots immediately.
3. Installs one manager subscription, one timeout, and at most one abort listener.
4. Registers its guarded settlement callback in a manager-owned waiter set.
5. Re-evaluates only the requested IDs on manager notifications.
6. Settles exactly once on condition completion, timeout, abort, or manager shutdown.
7. Removes the subscription, timer, abort listener, and waiter registration before resolving.

The existing synchronous initial call made by `subscribe()` must not cause double settlement. Completion and timeout races use one guarded settlement path.

`JobManager.shutdown()` first settles registered waiters as aborted, then performs its existing queued/running job cancellation. This deterministic ordering prevents shutdown from waiting for a wait timeout and does not rely on process-cancellation timing.

`JobManager` constructor dependencies gain injectable `setTimer` and `clearTimer` functions alongside the existing `now` clock. `elapsedMs` uses the injected `now`; timeout and race tests use the injected timer functions rather than global timer mocking.

## Tool registration and rendering

Register `subagent_wait` as a separate tool because blocking behavior should be explicit rather than hidden inside `subagent_status`.

Compact rendering shows the outcome and job states. Expanded rendering additionally shows the condition, configured timeout, and elapsed duration. It never renders collected output.

The description says to use the tool only when jobs are expected to finish soon and no useful parent work can proceed meanwhile.

## Error handling

- Invalid schemas are rejected by Pi before execution.
- Unknown or duplicate IDs produce one normal actionable tool diagnostic and no waiter.
- A timeout does not cancel jobs.
- An abort does not cancel jobs.
- One failed or cancelled child still counts as settled.
- Manager listener exceptions cannot strand the waiter.

## Testing strategy

Tests use fake time and the existing fake runner. They cover:

- Immediate satisfaction.
- `any` and `all` conditions.
- Queued, running, completed, failed, cancelled, collected, and discarded states.
- Default, minimum, and maximum timeouts.
- Rejection above 30 seconds.
- Unknown and duplicate IDs.
- Timeout without job mutation.
- Abort without job mutation.
- Parent tool-signal abort behavior at the tool boundary, without claiming Escape affects only this tool.
- Multiple simultaneous waiters.
- Completion versus timeout races.
- Completion versus abort races.
- Manager shutdown.
- Subscription, timer, and listener cleanup.
- Compact and expanded rendering.

## Documentation

The README will state that the parent cannot answer concurrently while waiting, waits last at most 30 seconds, aborting the parent turn does not cancel subagents, and immediate retry after timeout is discouraged.

## Success criteria

- The parent can wait once without polling rapidly.
- Default blocking is about 15 seconds and cannot exceed 30 seconds per call; guidance discourages immediate retry but does not enforce a cooldown.
- Timeout and abort leave all jobs running unchanged.
- Every exit path releases its resources.
- Wait results contain states but no subagent output.
