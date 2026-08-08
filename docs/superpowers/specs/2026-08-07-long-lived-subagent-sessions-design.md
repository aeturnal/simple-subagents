# Long-Lived Subagent Sessions Design

**Date:** 2026-08-07
**Status:** Approved, revised to essential scope

## Goal

Keep every `simple-subagents` child session open after its current work finishes. The parent can continue the same child context, redirect active work, receive structured progress or help requests, retrieve the result, and explicitly close the child when it is no longer needed.

## Current Behavior

Each job currently launches Pi once with `--mode json -p --no-session --no-extensions`, passes one task, ignores child stdin, captures one final answer, and exits. The parent keeps a bounded job record, not a living child session.

The parent can start, inspect, wait for, cancel, collect, or discard a job. It cannot send another instruction or answer a child that needs more context.

## Essential Scope

The first release will:

- Replace one-shot children with long-running Pi RPC processes.
- Keep every child open until explicit close or parent shutdown.
- Preserve separate-process isolation and existing read/write controls.
- Support normal follow-ups and urgent redirects.
- Number independent work requests as generations.
- Let children intentionally send short progress reports or help requests.
- Pause a child that asks for help and let the parent resume it.
- Keep routine reports in a bounded parent inbox.
- Add help requests to the parent model's next-turn context without starting a turn.
- Keep cancel, collect, and discard separate from close.
- Permit four actively working generations and eight open sessions.
- Guard parent-session replacement where Pi permits it.
- Close every child safely on reload or process exit.

## Deferred Scope

The first release will not add:

- Durable child sessions across reload, replacement, or exit.
- Automatic parent turns, retries, reviews, or workflow loops.
- Free-form prose classification for help requests.
- Several queued follow-ups per child.
- Several uncollected results per child.
- A full generation-history dashboard.
- Advanced inbox eviction policy.
- Configurable shutdown deadlines or detailed shutdown controls.
- A large RPC soak or stress suite beyond the essential contract tests.

These follow-on ideas are recorded in [`suggestion-box.md`](../../../suggestion-box.md), under “Expand long-lived session management after the essential release.”

## Chosen Approach

Each child remains a separate Pi process, but runs in RPC mode:

```text
pi --mode rpc \
  --no-session \
  --no-extensions \
  --extension <controlled-child-extension>
```

Pi allows an explicit extension path while unrelated extension discovery is disabled. The controlled child extension provides only structured reporting and internal graceful shutdown. User and project extensions remain unavailable inside children.

The parent uses Pi's existing RPC commands and events for prompting, steering, cancellation, activity, settlement, and state. It does not invent a second wire protocol or parse ordinary assistant prose for control messages.

## Modules

```text
Parent Pi session
  -> SubagentManager
       - session registry
       - generation state
       - scheduler
       - inbox and result state
  -> SessionRunner
       - Pi RPC commands and events
       - JSONL framing
       - child process lifecycle
  <-> child Pi process
       -> controlled reporting extension
```

### SessionRunner

The current one-shot process seam becomes a long-lived session seam. Its interface provides operations equivalent to:

```ts
interface RunningSubagentSession {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: (event: SubagentSessionEvent) => void): () => void;
  readonly closed: Promise<SubagentSessionExit>;
}
```

`prompt`, `steer`, and `abort` resolve when Pi accepts or rejects the command; later normalized events report work progress and settlement. `close` resolves only after the process exits or is definitively failed. The module hides RPC request IDs, JSONL parsing, Pi event shapes, process signals, and shutdown escalation. The production Pi RPC adapter and the controlled test adapter cross the same interface.

### SubagentManager

The manager owns policy:

- at most eight open sessions;
- at most four actively working generations;
- one queued normal follow-up per session;
- one uncollected result per session;
- generation ordering;
- report inbox and pending help state;
- lifecycle transitions and public snapshots.

The manager consumes normalized runner events and does not understand raw RPC records.

### Controlled child extension

The child extension registers:

```ts
subagent_report({
  kind: "progress" | "help_request",
  message: string,
})
```

A progress report returns normally. A help request ends the current agent run so the parent can answer. The child prompt tells the model to send progress only at meaningful milestones and to call a help request alone when it cannot continue without parent input.

The RPC tool-call ID deduplicates reports. The parent adds its session ID and current generation to each normalized report.

## State and Generations

Session state and current-work state are separate.

Session state:

```text
opening -> open -> closing -> closed
             \-> failed
```

Work state:

```text
queued -> running -> completed
                  -> waiting_for_parent -> running
                  -> cancelled
                  -> failed
```

The initial task is generation 1. Each later normal follow-up is the next generation.

Rules:

- A redirect steers the running generation and does not create a generation.
- A reply to `waiting_for_parent` resumes the same generation.
- Completed, failed, or cancelled work leaves the child session open.
- Collecting or discarding changes result state, not session state.
- Cancelling stops current work but leaves the session open.
- Closing active work cancels it, then closes the child.

Every result, report, wait response, and detailed status identifies its generation.

## Scheduling

The scheduler allows four active generations across up to eight open sessions. Cancelling work keeps its active slot until Pi reports `agent_settled`. Idle and waiting children do not use active-work slots.

A session may have one queued normal follow-up. A second queued follow-up is rejected with a clear diagnostic.

A terminal generation keeps one uncollected result. The next queued generation does not start until the parent collects or discards that result. This prevents result loss without adding a multi-result archive. Status explains when queued work is blocked by a ready result.

A start batch that would exceed eight open sessions is rejected as a batch.

## Parent-to-Child Instructions

Add:

```ts
subagent_send({
  id: "job-1",
  message: "Inspect the authorization checks",
  delivery: "follow_up" | "redirect",
})
```

`follow_up` is the default.

### Follow-up

- While running, store one queued next generation.
- While idle with no uncollected result, create and schedule the next generation.
- With an uncollected result, queue the next generation but block it until collect or discard.
- While waiting for the parent, treat the message as an answer and resume the same generation.
- Reject sends to closing, closed, or failed sessions.

### Redirect

- While running, send Pi's RPC `steer` command and remain in the same generation.
- While waiting for the parent, treat the message as the answer and resume the same generation.
- Otherwise reject redirect and instruct the caller to use `follow_up`.

Messages are validated and byte-limited before queueing or transport.

## Child-to-Parent Reports

### Progress

A progress report:

- enters the parent inbox;
- appears in status and live activity;
- does not enter the parent model's context automatically;
- does not interrupt either model;
- does not change work state.

### Help request

A help request:

- enters the parent inbox;
- becomes pending after the child reaches `agent_settled`;
- changes work state to `waiting_for_parent`;
- releases the active slot only after settlement;
- shows a human notification when UI is available;
- injects one bounded custom message into the parent model's next-turn context;
- does not automatically start a parent-model turn.

A parent reply clears the pending request only after the child accepts the prompt. Failed delivery leaves the request pending.

## Parent Inbox

Add:

```ts
subagent_inbox({ id?: "job-1" })
```

It returns unread reports for one session or all sessions, oldest first, then marks returned reports read.

Report text is capped at 4 KiB. Each session inbox has a simple 50 KiB total bound. When necessary, the manager removes the oldest progress reports and increments an omission count. The active unanswered help request is never removed.

`subagent_status` shows:

- session state;
- current generation and work state;
- whether one follow-up is queued;
- whether queued work is blocked by an uncollected result;
- unread report count;
- result-ready state;
- bounded recent activity;
- the pending help question.

## Results and Controls

`subagent_control` supports:

```ts
subagent_control({
  action: "cancel" | "collect" | "discard" | "close",
  ids: ["job-1"]
})
```

- `cancel` stops a queued or running current generation and keeps the child open. If no generation is active, it cancels the single queued follow-up instead. Partial output remains collectable.
- `collect` returns the current uncollected result, marks it collected, keeps the child open, and allows one blocked follow-up to run.
- `discard` drops the current uncollected result, keeps the child open, and allows one blocked follow-up to run.
- `close` rejects new work, cancels active work, clears the queued follow-up, closes the process, and releases the open-session slot.

Close is idempotent. Collected output remains bounded by the existing 50 KiB result limit. After collection, the manager keeps only bounded generation metadata and a preview rather than the full result body.

## Wait Semantics

`subagent_wait` waits for work, not session closure.

It returns when a requested child:

- is waiting for the parent; or
- has no active work and its latest generation completed, failed, or was cancelled.

A ready result or queued follow-up does not make wait continue indefinitely. The returned status explains that the follow-up is blocked until collect or discard.

Wait does not collect, answer, cancel, discard, or close anything. Existing timeout and abort behavior remains.

## Failure and Shutdown Behavior

Cancellation has two moments: Pi accepts `abort`, then Pi actually settles. The manager releases the active slot only after settlement.

Close uses one bounded graceful-shutdown policy hidden inside `SessionRunner`, with process-signal escalation if the child does not exit. Exact timing belongs in the implementation plan and runner constants, not the public interface.

If a child exits unexpectedly:

- its session becomes failed;
- current and queued work becomes failed;
- safe partial output remains collectable;
- pending RPC commands fail with one normalized error;
- active and open capacity is released;
- the parent receives a bounded notification;
- the child is not restarted automatically.

Malformed RPC records are counted, but their raw contents are discarded. If the channel becomes untrustworthy, the runner fails the session instead of guessing.

## Privacy and Bounds

- Child reporting is explicit and structured.
- Report text is capped at 4 KiB and inbox storage at 50 KiB per session.
- Generation output keeps the existing 50 KiB capture limit.
- Tool details expose bounded public projections, not internal session objects or profile prompts.
- Reasoning text is never stored or displayed; reasoning events remain fixed activity labels.
- Raw malformed protocol records are never retained.
- Child stderr, errors, activity, and terminal text remain sanitized and bounded.
- The child receives its profile prompt, task messages, selected tools, working directory, and launch settings—not the parent conversation.
- Pi's normal context compaction remains available inside the long-lived child.

## Parent Session Lifecycle

Pi provides cancellable checks before new, resume, fork, and clone. If children remain open, show:

```text
3 subagent sessions are still open.
Close all and continue?
```

Confirmation closes every child before replacement. Declining cancels the parent-session operation.

Pi cannot cancel reload or process exit from `session_shutdown`. Those paths close every child automatically and wait for cleanup. No child survives parent replacement or exit.

## Parent Experience

The live widget continues to show queued, running, waiting, and recently terminal work. Idle open sessions collapse into one reminder:

```text
3 idle subagent sessions remain open
```

Waiting-for-parent sessions remain visible because they need action.

`/subagents` continues to inspect sessions and shows session state, generation, work state, result readiness, inbox count, and queued-follow-up state. Rich generation browsing and new dashboard management controls are deferred. Detailed sending, collection, and close actions remain parent-model tools.

Existing tool names remain, and `subagent_send` plus `subagent_inbox` are added. IDs remain `job-N` for compatibility. Tool descriptions tell the parent model that collect, discard, and cancel leave sessions open and that it must call close when no more work is expected.

## Pi Compatibility

The repository installs Pi 0.82.1. Its shipped RPC implementation includes prompt, steer, abort, `agent_settled`, explicit extension loading alongside `--no-extensions`, and parent `nextTurn` delivery. Implementation will target the supported Pi 0.82.x line and require no upgrade unless a focused compatibility test proves otherwise.

## Essential Tests

Tests will verify:

1. The runner launches isolated RPC children and correlates commands and events.
2. Only the controlled child extension loads.
3. Generation 1 completes while the child remains open.
4. Follow-up, redirect, help reply, cancel, collect, discard, and close follow the documented state rules.
5. Four-active and eight-open limits hold during normal work and cancellation races.
6. One queued follow-up and one uncollected-result barrier prevent loss.
7. Progress stays in the inbox; help enters the inbox and parent next-turn context exactly once.
8. Help does not trigger a parent-model turn and releases its slot only after settlement.
9. Unexpected exit retains safe partial output and releases capacity.
10. Malformed protocol data cannot expose raw or reasoning content.
11. Status, wait, widget, and dashboard show the new session and generation meaning.
12. Parent replacement guards open children, while reload and shutdown close them safely.
13. Existing start, status, wait, collect, configuration, profile, access, model, thinking, and bounded-output behavior remains compatible.

Final verification:

```text
npm test
npm run typecheck
```

Run focused LSP and project diagnostics on every changed source and test file.

## Success Criteria

The first release succeeds when:

1. The parent starts a child and generation 1 completes without closing it.
2. The parent collects generation 1.
3. The parent starts generation 2 with the same child context.
4. The parent redirects generation 2 while it runs.
5. The child reports progress to the inbox.
6. The child asks for help, settles, and waits.
7. One help message enters the parent model's next-turn context without starting a turn.
8. The parent replies and generation 2 resumes.
9. The parent collects generation 2.
10. The parent explicitly closes the child.
11. No child process or reserved capacity remains.
