# Long-Lived Subagent Sessions Design

**Date:** 2026-08-07
**Status:** Approved

## Goal

Keep every `simple-subagents` child session open after its current work finishes so the parent can send follow-ups, redirect active work, receive structured progress or help requests, retrieve generation results, and explicitly close the child when it is no longer needed.

## Current Behavior

Each job currently launches Pi once with `--mode json -p --no-session --no-extensions`, passes one task as a command-line argument, ignores child stdin, captures the final answer, and treats process exit as job settlement. The process cannot accept another instruction. Only the bounded in-memory job record remains.

The parent can start, inspect, wait for, cancel, collect, or discard one-shot jobs. It cannot continue the same child context. Status and the dashboard expose bounded progress, but no structured child-to-parent communication channel exists. Automatic completion messages are intentionally disabled.

## Scope

This change will:

- Keep every successfully opened child session alive until explicit close or parent shutdown.
- Replace one-shot JSON/print children with long-running Pi RPC children.
- Preserve separate-process isolation.
- Support normal follow-ups and urgent redirects.
- Give each independent work request an explicit generation number.
- Let children intentionally report short progress updates or ask the parent for help.
- Maintain a bounded parent-side inbox.
- Add parent tools for sending instructions and reading the inbox.
- Keep collection separate from closing.
- Separate child-session state from current-work state.
- Limit the system to eight open sessions and four actively working generations.
- Guard cancellable parent-session replacement flows while children are open.
- Close every child safely on reload or process shutdown.

This change will not:

- Persist or reconnect child sessions across parent reload, replacement, or exit.
- Automatically start a parent-model turn when a child asks for help.
- Add automatic retry, review, or workflow loops.
- Infer help requests from free-form prose.
- Load user or project extensions inside children.
- Add a full message editor to the `/subagents` dashboard.
- Build a new RPC protocol when Pi's existing RPC mode already provides the required transport.

## Chosen Approach

Each child will run as a separate long-lived Pi RPC process. The extension will launch it with unrelated extension discovery disabled and one explicit, package-controlled child extension enabled:

```text
pi --mode rpc \
  --no-session \
  --no-extensions \
  --extension <controlled-child-extension>
```

Pi documents that explicit `--extension` paths still load when `--no-extensions` disables discovery. The controlled extension will expose only the structured reporting tool and an internal graceful-shutdown command. Profile tool allowlists will continue to select the permitted built-in tools, with the controlled reporting tool added by the launcher.

The parent will use Pi's existing RPC commands and events for prompts, steering, cancellation, state, messages, activity, and settlement. It will not parse ordinary assistant prose to discover control messages.

## Architecture

```text
Parent Pi session
  -> SubagentManager
       - session registry
       - work generations
       - scheduler
       - bounded inbox
       - result retention
       - lifecycle policy
  -> RPC SessionRunner adapter
       - command correlation
       - JSONL framing
       - child process lifecycle
       - event reduction
  <-> child Pi RPC process
       -> controlled reporting extension
```

### SessionRunner module

The current one-shot process seam will deepen into a long-lived session seam. Its interface will expose behavior such as:

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

The module will be named `SessionRunner`. Its interface must hide RPC request IDs, JSONL parsing, process signals, Pi event shapes, and shutdown escalation. Callers and tests will cross this seam rather than manipulating child stdin or raw events directly.

There are two adapters at this real seam:

- the production Pi RPC process adapter;
- the controlled in-memory test adapter.

### SubagentManager module

The manager owns policy rather than transport:

- open-session capacity;
- active-work concurrency;
- generation creation and ordering;
- queued follow-ups;
- inbox storage and read state;
- result collection and discard state;
- work and session lifecycle transitions;
- subscriber snapshots for tools and UI.

The manager will not understand raw RPC records. The runner will emit normalized session events.

### Controlled child extension

The child extension will register:

```ts
subagent_report({
  kind: "progress" | "help_request",
  message: string,
})
```

It will also provide an internal graceful-shutdown command used only by the parent runner. It will not provide nested subagents, networking, parent-session access, or arbitrary extension discovery.

A progress report returns normally so child work may continue. A help request returns a terminating tool result and the child prompt will instruct the model to call it alone when it needs a parent answer. The manager treats the request as pending only after the child reaches `agent_settled`; this prevents the work slot from being released while the model is still active.

The RPC tool call ID is the report's deduplication identity. The parent annotates the normalized report with its own session ID and active generation.

## State Model

Session state and work state are separate.

### Session state

```text
opening -> open -> closing -> closed
             \-> failed
```

- `opening`: the RPC process is starting and has not completed readiness checks.
- `open`: the process can accept commands.
- `closing`: shutdown is in progress and the session still occupies an open-session slot.
- `closed`: the process exited through explicit close or parent shutdown.
- `failed`: the process exited unexpectedly or the RPC channel became unusable.

`opening`, `open`, and `closing` count toward the eight-session limit. `closed` and `failed` do not. Failed records remain visible until explicitly closed or removed, but they do not reserve capacity.

### Work state

```text
queued -> running -> completed
                  -> waiting_for_parent -> running
                  -> cancelled
                  -> failed
```

An open child with completed, cancelled, or failed work remains available for another generation.

### Generations

Every independent normal work request receives a monotonically increasing generation number:

```text
job-1 · generation 1 · completed
job-1 · generation 2 · running
```

Rules:

- The initial task is generation 1.
- A normal follow-up creates the next generation.
- A redirect steers the currently running generation and does not increment the number.
- A parent response to `waiting_for_parent` resumes the same generation.
- Collecting or discarding a result changes that generation's result state, not the child-session state.
- Cancelling changes the current generation's work state, not the child-session state.
- Closing terminates the complete session.

A generation records its instruction, timing, bounded activity, usage, reported model, captured result, errors, collection state, and reports. Status and collected output always name the generation.

## Scheduling and Capacity

The system permits:

- at most eight open or opening child sessions;
- at most four actively working generations across all sessions;
- at most eight queued normal follow-ups per session;
- at most eight uncollected generation results per session.

`running` and cancelling-but-not-yet-settled work occupy a working slot. Idle, queued, completed, failed, cancelled, and `waiting_for_parent` work do not.

The manager queues normal follow-ups itself instead of using Pi's internal follow-up queue. After one generation reaches `agent_settled`, the slot is released and the scheduler may start any eligible queued generation. This provides exact generation boundaries and fair global concurrency.

A start batch that would exceed eight open sessions is rejected as a batch with a clear capacity diagnostic. A session with eight uncollected results refuses additional normal work until the parent collects or discards at least one result. No completed result is silently removed to make room.

## Parent-to-Child Instructions

Add:

```ts
subagent_send({
  id: "job-1",
  message: "Inspect the authorization checks",
  delivery: "follow_up" | "redirect",
})
```

`delivery` defaults to `follow_up`.

### Follow-up

- If work is running, create and queue the next generation.
- If the child is open and idle, create the next generation and schedule it immediately subject to the four-worker limit.
- If the child is waiting for the parent, treat the message as the answer and resume the same generation.
- If the session is opening, queue the generation until readiness.
- If the session is closing, closed, or failed, reject the message.

### Redirect

- If a generation is running, send an RPC `steer` command and keep the same generation.
- If the child is waiting for the parent, treat the message as the answer and resume the same generation.
- In any other work state, reject redirect with a diagnostic instructing the caller to use `follow_up`.

Messages are byte-limited and validated before entering a queue or the RPC channel.

## Child-to-Parent Communication

### Progress reports

A `progress` report:

- enters the bounded parent-side inbox;
- appears in status and live UI activity;
- does not enter the parent model's context automatically;
- does not interrupt either model;
- does not change the work state.

### Help requests

A `help_request` report:

- enters the parent-side inbox;
- becomes the session's pending help request after child settlement;
- changes work state to `waiting_for_parent`;
- releases the active-work slot only after `agent_settled`;
- produces an immediate human notification when UI is available;
- injects one short custom message into the parent model's next-turn context;
- never starts a parent-model turn automatically.

The parent-context injection uses Pi's `nextTurn` delivery and is deduplicated by report identity. The injected message contains only the bounded session ID, generation, and help text. It does not contain raw child events, reasoning, prompts, or tool details.

A parent reply through `subagent_send` clears the pending request only after the prompt is accepted by the child. If delivery fails, the request remains pending and visible.

## Parent Inbox

Add:

```ts
subagent_inbox({
  id?: "job-1"
})
```

Without an ID, it returns unread reports across all sessions. With an ID, it returns unread reports for that session. Successful retrieval marks the returned reports as read. Results are bounded and sorted oldest first.

Each report stores:

- report identity;
- session ID;
- generation;
- kind;
- bounded text;
- timestamp;
- read state.

Report text is limited to 4 KiB. Each session retains at most 100 report entries. When the inbox is full, it removes the oldest read progress reports first, then the oldest unread progress reports, and records an omission notice. A current unanswered help request is never silently removed.

`subagent_status` remains the compact status interface. It reports unread inbox count, uncollected result count, queued follow-up count, current generation, work state, session state, bounded recent activity, and the bounded pending-help question.

## Results and Controls

Extend `subagent_control` with `close` while retaining existing actions:

```ts
subagent_control({
  action: "cancel" | "collect" | "discard" | "close",
  ids: ["job-1"]
})
```

### Cancel

- Stops only the current generation.
- Keeps the child session open.
- Does not discard partial output.
- Does not release the working slot until the child reaches idle settlement.
- Leaves queued follow-ups queued unless explicitly discarded or the session is closed.

### Collect

- Returns all uncollected terminal generation results for each selected session, oldest first.
- Keeps the session open.
- Marks returned generations collected.
- Releases the full in-memory result body after it has been returned into the parent conversation.
- Retains bounded metadata and a result preview for history and status.

The combined collected payload remains bounded. Formatting reserves space for each included generation and clearly reports any section truncation.

### Discard

- Discards all uncollected terminal generation results for each selected session.
- Keeps the session open.
- Retains bounded generation metadata indicating that the result was discarded.

### Close

- Rejects new sends immediately.
- Cancels active work.
- Clears queued follow-ups.
- Preserves terminal and partial results long enough to report close diagnostics.
- Requests graceful child shutdown.
- Escalates to process signals when required.
- Releases the open-session slot only after the process exits or is definitively failed.

Calling close on an already closed session is idempotent.

## Wait Semantics

`subagent_wait` waits for current scheduled work, not for the child session to close.

For each requested session it is satisfied when either:

- work is `waiting_for_parent`, even if later follow-ups remain queued; or
- no generation is running and no follow-up is queued, and the latest work is completed, failed, or cancelled.

A waiting generation blocks later queued generations until the parent replies or cancels it. This prevents unrelated follow-up work from bypassing an unanswered help request.

Waiting does not collect results, answer help requests, close sessions, or cancel queued work. Existing timeout and abort behavior remains.

## RPC Transport and Settlement

Every RPC command receives a unique request ID. The session runner correlates responses, applies a 30-second command-acceptance timeout, and emits normalized failures when a command is rejected or the process exits first. Long model work is tracked by events and is not limited by this command timeout.

### Cancellation settlement

Cancellation has two moments:

1. Pi accepts `abort`.
2. Pi emits settlement and reports itself idle.

The manager retains the active-work slot until the second moment. A late result or telemetry event during cancellation is still applied to the cancelling generation.

### Graceful close

Closing follows this sequence:

1. abort active work if needed;
2. wait up to five seconds for idle settlement;
3. invoke the controlled child's shutdown command;
4. wait up to five seconds for process exit;
5. send `SIGTERM` if it remains alive;
6. send `SIGKILL` if it remains alive after the existing five-second signal-escalation window.

All paths resolve the session's single `closed` promise exactly once.

### Unexpected exit

If a child exits unexpectedly:

- session state becomes `failed`;
- current and queued generations become failed;
- safe captured partial output remains collectable;
- pending RPC commands reject with one normalized session-exit error;
- active and open capacity is released;
- the parent receives a bounded notification;
- no automatic restart occurs.

Malformed protocol records are counted but their raw contents are discarded. A bounded number of isolated malformed records may be reported as safe diagnostics. If framing or command correlation is no longer trustworthy, the runner fails and closes the session rather than continuing with uncertain state.

## Memory, Privacy, and Capture Bounds

- Report messages are capped at 4 KiB.
- Each session inbox retains at most 100 reports under the eviction rules above.
- Each generation result keeps the existing 50 KiB captured-output limit.
- Each session retains at most eight uncollected results.
- Collected result bodies are released from the manager after delivery to the parent conversation.
- Tool result details expose only bounded public projections, never complete internal sessions or profile prompts.
- Reasoning text is never stored or displayed. Reasoning events produce fixed activity labels only.
- Raw malformed RPC records are never retained.
- Child stderr, errors, activity, and terminal text remain sanitized and bounded.
- The child receives only its profile prompt, task messages, selected tools, working directory, and launch model/thinking settings. It does not receive the parent conversation.
- Pi's normal child context compaction remains enabled so a long-lived conversation can reduce old context when needed.

## Parent Session Lifecycle

Pi exposes cancellable hooks before new, resume, fork, and clone, but not before reload or process exit.

### Cancellable replacement flows

When open children exist before new, resume, fork, or clone, show:

```text
3 subagent sessions are still open.
Close all and continue?
```

- Confirmation closes all children, waits for settlement, then permits replacement.
- Declining cancels the parent-session operation.

### Reload and exit

Reload, quit, terminal close, and process signals cannot be cancelled at the extension hook. `session_shutdown` therefore closes every child automatically and waits for cleanup. No child session survives replacement or exit.

## User Interface

### Live widget

The widget continues to show queued and running work, waiting sessions, and recently terminal generations. After the existing five-second terminal display window, idle open sessions collapse into one reminder:

```text
3 idle subagent sessions remain open
```

Waiting-for-parent rows remain visible because they require action.

### Dashboard

`/subagents` remains the durable view. Rows show session state, current generation, work state, result count, inbox count, and queued follow-ups, for example:

```text
job-1 · open · generation 2 completed · 1 result ready
job-2 · open · generation 1 waiting for parent
job-3 · open · generation 3 running
```

The dashboard adds close-selected and confirmed close-all actions alongside cancellation and inspection. Sending detailed text remains a model tool operation rather than a dashboard editor.

## Pi Version Compatibility

The repository currently installs Pi 0.82.1. Its shipped RPC implementation and documentation include `prompt`, `steer`, `abort`, `agent_settled`, explicit `--extension` loading alongside `--no-extensions`, and parent `nextTurn` message delivery. The implementation will target the repository's supported Pi 0.82.x line and will not require a Pi upgrade unless a missing behavior is proven by a focused compatibility test.

## Tool Compatibility

Existing tools remain:

- `subagent_agents`
- `subagent_start`
- `subagent_status`
- `subagent_wait`
- `subagent_control`

New tools are:

- `subagent_send`
- `subagent_inbox`

Identifiers remain `job-N` for compatibility, though they now identify child sessions. Existing callers that start, wait, and collect still receive results. They must adopt explicit close to avoid eventually reaching the eight-open-session limit. Capacity diagnostics will explain how to close sessions.

Documented behavior changes:

- terminal work no longer closes the child;
- cancel, collect, and discard keep the child open;
- close releases the child and its capacity;
- status, wait, inbox, and collection name generations;
- automatic completion messages remain disabled;
- only help requests enter parent next-turn context automatically.

Tool descriptions and prompt guidelines will tell the parent model that sessions remain open, results do not close them, and `close` must be called when no further work is expected. The dashboard reminder and capacity diagnostic provide the same guidance to the human user.

## Testing

### Session runner tests

Verify:

1. Pi launches in RPC mode with piped stdin and stdout.
2. Unrelated extensions are disabled and only the controlled child extension is explicit.
3. Profile tool permissions plus `subagent_report` form the child allowlist.
4. RPC commands correlate responses by ID.
5. Prompt, steer, abort, state, and shutdown commands map to normalized operations.
6. Agent, turn, message, tool, telemetry, report, queue, and settlement events reduce correctly.
7. Cancellation waits for idle settlement.
8. Close escalates through graceful shutdown, `SIGTERM`, and `SIGKILL` without double settlement.
9. Unexpected exit rejects pending commands and retains safe partial output.
10. Malformed records never expose raw content.

### Manager tests

Verify:

1. Generation 1 completion leaves the child open.
2. Follow-ups create monotonically increasing generations.
3. Redirects stay within the active generation.
4. Parent replies resume the waiting generation.
5. Cancellation keeps the session open.
6. Close cancels work, clears queued work, and closes the session.
7. Only four generations are active at once.
8. Eight sessions may be open and a capacity-exceeding batch is rejected atomically.
9. Idle and waiting sessions do not consume active-work slots.
10. Queued work starts fairly when capacity becomes available.
11. A cancelling generation retains its slot until actual settlement.
12. Results remain collectable after cancellation or failure.
13. Collection and discard keep sessions open.
14. Eight uncollected results block additional work without losing data.
15. Late events and process-exit races cannot corrupt later generations.

### Communication tests

Verify:

1. Progress reports enter only the inbox and status activity.
2. Help requests enter the inbox and parent next-turn context exactly once.
3. Help requests do not trigger a parent-model turn.
4. Help state begins only after child settlement.
5. A failed parent reply leaves the request pending.
6. Inbox retrieval marks returned reports read.
7. Inbox eviction follows the documented priority.
8. The current unanswered help request is preserved.
9. Report text is bounded, sanitized, and associated with the correct generation.

### Tool and UI tests

Verify:

1. New schemas reject invalid delivery values, unknown fields, and oversized messages.
2. Status reports session state, generation, work state, inbox, results, and queues.
3. Wait returns for completion, failure, cancellation, or parent waiting.
4. Control actions use the new non-closing semantics except for close.
5. Dashboard cancel, close-selected, and close-all target the intended sessions.
6. Waiting rows stay visible and idle sessions collapse into the summary reminder.
7. New, resume, fork, and clone are cancelled when close-all confirmation is declined.
8. Replacement proceeds only after confirmed close-all settles.
9. Reload and shutdown close all children idempotently.

### Verification commands

```text
npm test
npm run typecheck
```

Run focused LSP and project diagnostics on all changed source and test files before completion.

## Success Criteria

The complete workflow must work:

1. The parent starts a subagent.
2. Generation 1 completes and the child remains open.
3. The parent collects generation 1 without closing the child.
4. The parent sends generation 2 and the child retains its earlier context.
5. The parent redirects generation 2 while it is running.
6. The child sends a progress report that remains in the inbox.
7. The child sends a help request, settles, and waits.
8. The parent receives one next-turn context message without an automatic model turn.
9. The parent replies and generation 2 resumes.
10. The parent collects the final generation 2 result.
11. The parent explicitly closes the child.
12. The process exits, all slots are released, and no child remains.
13. Parent replacement cannot abandon open children, and reload or exit closes them safely.
