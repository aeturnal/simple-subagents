# Subagent Completion Wait Design

## Summary

Remove automatic “Jobs may be ready” messages and make `subagent_wait` the explicit way for the parent agent to pause for expected job completion. Increase the wait default to 60 seconds and its maximum to 300 seconds. A wait remains event-driven and returns immediately when its requested condition is satisfied.

This change supersedes the completion-message behavior in `2026-07-29-01-stale-safe-subagent-notifications-design.md` and the timeout values in `2026-07-29-02-subagent-wait-design.md`.

## Goals

- Stop completion messages that arrive after a result has already been collected.
- Remove the automatic completion-message mechanism rather than adding more stale-message handling.
- Reduce repeated short `subagent_wait` calls for jobs expected to finish soon.
- Preserve immediate, event-driven completion detection.
- Keep job execution, status, collection, cancellation, discard, and dashboard behavior unchanged.

## Non-goals

- Automatically collecting job output.
- Changing which job states satisfy `subagent_wait`.
- Polling job state on an interval.
- Adding a notification preference or replacement notification channel.
- Changing subagent process timeouts or cancellation behavior.

## Completion detection

`subagent_wait` already detects completion independently of the notification mechanism. `JobManager.waitFor()` subscribes to manager updates. When a job finishes, `JobManager.finish()` updates its state and calls `notify()`. The waiter rechecks its requested IDs and resolves as soon as its `any` or `all` condition is satisfied.

A configured timeout is only an upper bound. A wait configured for 300 seconds can return after a few seconds when the requested jobs settle.

## Notification removal

Remove the complete `simple-subagents-ready` path:

- `installCompletionNotifier()` and its timer/state machinery.
- Its `session_start` installation and `session_shutdown` cleanup.
- The `simple-subagents-ready` message renderer.
- Timer dependencies used only by completion notifications.
- Tests dedicated to notification delivery, stale filtering, rendering, and cleanup.

No replacement message is emitted. Jobs remain visible through `subagent_status` and the dashboard, and their output remains available through explicit collection.

## Wait interface

Keep the existing `subagent_wait` shape and semantics:

```ts
subagent_wait({
  ids: ["job-1", "job-2"],
  until: "any" | "all",
  timeoutMs: 60_000,
})
```

Timeout schema:

- Minimum: `100` ms.
- Default: `60_000` ms.
- Maximum: `300_000` ms.

The implementation fallback used when `timeoutMs` is omitted must also be `60_000` ms. Tool guidance must describe the five-minute maximum without implying that every call lasts for its full timeout.

## Responsiveness

A pending wait occupies the parent agent’s current tool call, so a five-minute maximum can delay the parent from processing queued input. This is an accepted trade-off for reducing repeated waits. The wait still responds to its abort signal, never cancels a child merely because it times out or is aborted, and releases its timer and subscription on every exit path.

## Testing

Update tests to verify:

- `WaitParams` exposes a 60-second default and 300-second maximum.
- Omitting `timeoutMs` passes `60_000` to `JobManager.waitFor()`.
- Tool guidance states the new maximum.
- Existing completion-before-timeout tests continue proving event-driven early return.
- The extension no longer registers or emits `simple-subagents-ready` messages.
- Existing job status, wait, collection, dashboard, and shutdown tests continue passing.

Delete tests whose only subject is the removed notifier.

## Documentation

Update user-facing wait guidance that says the maximum is 30 seconds. Remove documentation that promises automatic completion notices. State that waits return early when jobs settle and that job status and the dashboard remain available when the parent is not waiting.

## Success criteria

- No “Jobs may be ready” custom message is registered or emitted.
- A wait without `timeoutMs` uses 60 seconds.
- The schema accepts values through 300 seconds and rejects larger values.
- Waits resolve immediately when their requested completion condition becomes true.
- Removing notifications does not change job lifecycle or result collection behavior.
