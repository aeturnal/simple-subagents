# Live Turn-by-Turn Token Usage Design

**Date:** 2026-08-05
**Status:** Superseded by [`2026-08-05-live-widget-priority-details-design.md`](./2026-08-05-live-widget-priority-details-design.md)

> Historical note: this design proposed a narrow `onUsage` callback. The released implementation uses the richer `ProcessTelemetry` payload through `onTelemetry`, which carries cumulative usage and the observed model. Do not implement the interface described below.

## Goal

Show exact cumulative token usage for a running subagent after each completed assistant message, rather than waiting for the entire subagent process to finish.

The live widget will keep showing one combined count: input tokens plus output tokens.

## Current Behavior

`PiProcessRunner` receives exact usage on each assistant `message_end` event and accumulates it internally. That usage is copied into `job.usage` only when the complete process result settles. As a result, the live widget normally shows no token count while a subagent is running and shows the final count only after settlement.

The widget's 80 ms animation interval only requests redraws. It cannot display new usage until the shared job snapshot contains that usage.

## Scope

This change will:

- Publish cumulative exact usage after each assistant message ends.
- Store that usage on the running job.
- Notify all existing job subscribers.
- Let the current widget animation display the newest value on its next frame.
- Make the same fresher usage visible in `/subagents` and `subagent_status`.

This change will not:

- Estimate tokens from text.
- Add a tokenizer dependency.
- Add a timer or increase redraw frequency.
- Split input and output counts in the live widget.
- Change final result accounting or token formatting.

## Design

### Process runner callback

Add an optional usage callback to `ProcessRunOptions`:

```ts
onUsage?(usage: UsageStats): void;
```

The callback is optional to preserve compatibility for direct `ProcessRunner` users. `JobManager` will always provide it for managed jobs.

On every assistant `message_end`, `PiProcessRunner` will:

1. Increment the cumulative turn count.
2. Add the message's exact input, output, cache, and cost fields to its cumulative usage.
3. Emit a cloned cumulative usage snapshot through `onUsage`.

The callback occurs only after all fields from that message have been applied, so subscribers never see a partly updated turn.

### Job manager update

`JobManager` will provide `onUsage` when it starts a process. A focused private method will accept each snapshot, copy it into `entry.job.usage`, and call the existing subscriber notification path.

Usage updates are accepted while the process-backed job is `running` or in the active `cancelled` state awaiting process settlement. Late callbacks after any other state are ignored.

Usage is state, not activity. It will not be inserted into `job.progress` and will not consume bounded progress-history capacity.

### Widget rendering

No widget accounting or timer logic changes are required.

For a running job, the manager notification supplies a new immutable job snapshot to `LiveSubagentsWidget`. While animation is active, `setJobs()` avoids an immediate duplicate render. The existing 80 ms interval requests the next render, which reads the new cumulative usage. The visible delay is therefore at most roughly one animation frame.

If no animation is active, the controller's existing update path requests a render normally.

The formatter will continue to display:

```text
<input + output> tokens
```

using the existing compact formatting rules.

### Settlement and errors

The process result remains authoritative. `JobManager.applyResult()` will continue replacing `job.usage` with the final result usage for completed, failed, and cancelled jobs.

A missing usage callback has no effect on process execution. A provider message without usage contributes zero through the existing parsing behavior. No token estimate or misleading partial exact count is introduced.

Runner callback snapshots are cloned before crossing the boundary. Manager job snapshots remain independently cloned for subscribers, preserving the existing immutability guarantees.

## Data Flow

```text
OpenAI final event for one response
  -> Pi assistant message_end
  -> PiProcessRunner accumulates exact usage
  -> onUsage(cumulative snapshot)
  -> JobManager updates job.usage and notifies
  -> LiveSubagentsWidget receives a new job snapshot
  -> existing 80 ms frame renders input + output
```

A multi-turn subagent repeats this flow after every assistant message. The count stays unchanged between message completions and becomes exact again at each completion boundary.

## Testing

Tests will verify:

1. Multiple assistant `message_end` events emit cumulative usage snapshots.
2. Input and output usage accumulates without double counting.
3. Turns, cache usage, and cost remain cumulative in the emitted snapshot.
4. Callback values cannot mutate the runner's internal usage.
5. `JobManager` publishes usage before the process settles.
6. Job subscriber snapshots remain independent and immutable.
7. Late usage updates after settlement are ignored.
8. The live formatter displays the combined input-plus-output total from a running job snapshot.
9. Existing widget registration, 80 ms animation, expiry timer, cancellation, failure, and final settlement behavior remain unchanged.

## Success Criteria

- A running multi-turn subagent's token count advances after each completed assistant message.
- Displayed live values are exact cumulative provider values, never estimates.
- The widget still uses one animation interval and no usage-specific timer.
- Final usage remains identical to the process result.
- Existing `/subagents`, status tools, lifecycle behavior, and resource cleanup continue to work.
