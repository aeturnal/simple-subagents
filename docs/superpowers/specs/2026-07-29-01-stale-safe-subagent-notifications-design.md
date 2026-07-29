# 01 — Stale-Safe Subagent Notifications Design

## Summary

Completion notifications must describe current work without forcing unnecessary user-facing turns. Before a debounced notification is sent, the extension will remove jobs that have already been collected or discarded. Because Pi follow-up messages cannot be retracted after they are queued, every delivered notice will use wording that remains safe if its state later becomes stale.

This is an independently releasable correction to notification behavior. It does not collect results automatically, add notification preferences, or change the job state machine.

## Goals

- Suppress notifications for results handled before the debounce flush.
- Include only still-collectable jobs in mixed notification batches.
- Make already-queued messages safe if collection or discard happens before delivery.
- Let the parent decide whether to make an explicit collection tool call for results needed by an already active user-requested task, without forcing another confirmation turn.
- Preserve inbox results if message delivery fails.
- Keep notification timers and state session-scoped.

## Non-goals

- Automatic extension-side result collection or any notification path that calls `manager.collect()`.
- A `completionPolicy` setting.
- Retracting messages already queued inside Pi.
- Persisting notification state across sessions.
- Adding notification state to `JobState`.
- Changing collection, discard, or cancellation semantics.

## Terminology

A job is **collectable** when its current state is `completed`, `failed`, or `cancelled`. A notification is **stale** when every referenced job has since become `collected`, `discarded`, or unavailable.

## User-visible behavior

When collectable jobs remain at flush time, the extension sends a grouped follow-up message:

```text
Jobs may be ready: job-2 (completed), job-4 (failed).
Check their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.
```

The wording intentionally says “may be ready.” If the parent processes the follow-up after a result was handled, it is instructed to check current state and take no action. If a result is still needed for the active user-requested task, the parent may make the normal explicit collection tool call. The extension itself never calls `manager.collect()` from notification code; this is the boundary meant by “no automatic collection.”

If all pending jobs have become non-collectable before the debounce flush, no message is sent. In a mixed batch, stale IDs are omitted while collectable IDs remain.

## Architecture

`installCompletionNotifier()` keeps its existing session-local structures:

- `previous`: last observed process state by job ID.
- `pending`: terminal transitions waiting for the debounce flush.
- `notified`: job IDs whose one terminal-transition notice has been scheduled.

At flush time, the notifier:

1. Copies and clears `pending`.
2. Re-reads each candidate with `manager.get(id)`.
3. Keeps only jobs currently in `completed`, `failed`, or `cancelled`.
4. Returns without calling `pi.sendMessage()` if none remain.
5. Sends one grouped, stale-safe follow-up for the remaining jobs.

No new state is added to `Job`, `JobManager`, or persisted session entries. A terminal transition remains eligible for at most one notification even when unrelated manager updates occur.

## Pi message delivery

The extension continues using:

```ts
{ deliverAs: "followUp", triggerTurn: true }
```

A follow-up can wait behind an active parent turn and cannot be reliably removed after queueing. State filtering therefore prevents staleness before queueing, while action-neutral wording handles staleness after queueing.

`pi.sendMessage()` failures are caught at the notifier boundary. Delivery failure must not collect, discard, mutate, or lose the corresponding inbox result. The notifier intentionally does not retry a failed send because retrying can create duplicate follow-ups when delivery success is uncertain; the result remains discoverable through status and the dashboard.

## Rendering

The existing `simple-subagents-ready` message renderer remains. Its `details.jobIds` contains only IDs retained by the flush-time filter. Expanded rendering may show those IDs but does not render job output.

## Lifecycle and cleanup

`session_shutdown` continues to:

- Unsubscribe from `JobManager`.
- Clear the outstanding debounce timer.
- Clear pending notification candidates.

A flush callback that races with shutdown must become a no-op and must not schedule another timer.

## Error handling

- A missing job is treated as stale and omitted.
- A collected or discarded job is omitted.
- One stale job does not suppress other collectable jobs in the same batch.
- A thrown message-delivery error is contained and leaves jobs untouched.
- Listener failures remain unable to disrupt `JobManager`.

## Testing strategy

Unit tests use injected timers, a fake Pi API, and the existing manager seam. They cover:

- A completed job that remains collectable through flush.
- Collection before the debounce flush.
- Discard before the debounce flush.
- A mixed batch containing collectable and stale jobs.
- Collection after a follow-up is queued but before the parent processes it.
- Failed and cancelled jobs.
- No duplicate notice after unrelated manager updates.
- Message-delivery failure preserving inbox state.
- Shutdown cancelling an outstanding debounce.
- Flush and shutdown race ordering.

Renderer tests verify the new wording, filtered IDs, compact output, and expanded output.

## Documentation

The README will explain that completion notices are availability hints, the parent checks current state before acting, and results are still collected explicitly.

## Success criteria

- Handled jobs do not generate a notification when handled before flush.
- Stale queued notices use wording that does not request another user question and tells the parent to check current state before collection.
- Notification code never collects or discards a job.
- Delivery failures do not lose results; notification loss is accepted and is not retried.
- Existing job and tool APIs remain unchanged.
