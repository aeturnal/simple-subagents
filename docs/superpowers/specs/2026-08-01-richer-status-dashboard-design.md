# Richer Status and Stable Dashboard Design

## Summary

Make `subagent_status` useful enough to understand what jobs are doing, and make `/subagents` a stable read-only inspection interface with cancellation support.

The change introduces one shared semantic status projection consumed by both views. It removes timer-driven full-screen redraws, bounds every dashboard mode to the terminal viewport, adds an explicit scrollable full-detail mode, sanitizes child-controlled terminal text, and guarantees dashboard cleanup during session teardown.

Collection and discard remain parent-agent operations through `subagent_control`. The dashboard will no longer collect, discard, or inject job results into the conversation.

## Goals

- Show task, state, timing, model, usage, and recent activity in `subagent_status`.
- Keep status output bounded and prevent uncollected result bodies from entering model context.
- Make the dashboard and status tool agree on shared job facts.
- Keep the normal dashboard compact.
- Provide a bounded scrollable view for complete captured details.
- Eliminate the known overflow, duplicate-output, repeated `Working...`, and drifting-screen failure paths.
- Preserve job lifecycle semantics and the existing five-tool interface.

## Non-goals

- Returning complete job output from `subagent_status`.
- Collecting or discarding from `/subagents`.
- Adding persistence, retries, steering, resume, chains, or worktrees.
- Declaring that a quiet job is stuck.
- Adding a timer merely to keep elapsed time visually exact.
- Reworking captured-output or collection limits.

## Root-cause findings

The existing dashboard has two directly reproduced problems and two lifecycle hazards.

### Unbounded height

The detail view wraps child output to terminal width but emits every resulting line. A 47.7 KB captured output produced 1,375 dashboard lines at an 80-column width. The component has no viewport-height limit, so large output can force the differential terminal renderer far beyond the visible screen.

### Competing timer-driven redraws

While any job is running, the dashboard calls `requestRender()` every second to update elapsed time. Manager progress updates also request renders, and Pi's active `Working...` indicator has its own animation. These independent render sources compete over one full-screen differential renderer. `pi-subagents` removed the same timer-driven pattern after it caused repeated full-TUI redraws and flicker.

### Teardown gap

The command currently closes its subscription and timer only when its `ctx.ui.custom()` promise settles. Extension/session cleanup clears the compact widget but does not explicitly close an open dashboard. Reload, session replacement, or shutdown can therefore leave stale callbacks targeting a replaced TUI.

### Child-controlled terminal sequences

Output, stderr, errors, and progress are child-controlled strings. Width helpers preserve ANSI control sequences. Styling codes are safe, but cursor movement, erase commands, carriage returns, and unrelated OSC commands can corrupt the real terminal even when visible width is valid.

## Shared status seam

Add a pure module at `src/job-status.ts`.

Its external interface maps an immutable `Job` snapshot and a supplied current time into a bounded semantic projection. The projection contains facts, not presentation strings:

```ts
interface JobStatus {
  id: string;
  state: JobState;
  task: string;
  agent: string;
  access: AccessMode;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  queueDurationMs?: number;
  runDurationMs?: number;
  launchModel?: string;
  launchThinking?: string;
  reportedModel?: string;
  usage: UsageStats;
  recentActivity: StatusActivity[];
  resultReady: boolean;
  hasError: boolean;
  captureNotices: string[];
}
```

Exact names may change during planning, but these responsibilities must remain together.

The module also owns bounded plain-text status formatting and safe text-preview helpers. It must not own ANSI colors, keyboard controls, terminal layout, manager state, or result collection.

`tools.ts` consumes the projection for model-facing status text. `dashboard.ts` consumes it for rows and compact details. The full dashboard view may additionally read captured output and diagnostics from the selected `Job`, because that view is local TUI content rather than model context.

`output.ts` continues to own collected-result formatting and the 50 KiB collection boundary.

## `subagent_status` behavior

### Specific job

`subagent_status({ id })` returns a bounded report similar to:

```text
job-2 — running for 2m 14s
Task: Review authentication changes
Agent: reviewer · Access: read-only
Model: openai-codex/gpt-5.6-terra · Thinking: medium
Usage: 28k input · 3k output · 6 turns · $0.08
Recent activity:
  4s ago  Completed read
  2s ago  Started lsp_diagnostics
  now     Checking diagnostics in src/auth.ts
```

Terminal, uncollected jobs add:

```text
Result ready — collect job-2 to read it.
```

The report includes:

- ID and process state.
- A bounded task preview.
- Profile and access mode.
- Queue, running, or final duration when timestamps allow it.
- Launch model and thinking selection.
- Reported model when available.
- Current accumulated usage and turn count.
- At most three bounded recent activity entries.
- A result-ready hint for completed, failed, or cancelled jobs.

The report excludes:

- Complete output.
- Complete partial assistant prose.
- Complete stderr or errors.
- Malformed protocol samples.
- Profile system prompts.

Recent assistant-text activity may be represented only as a short sanitized preview. Tool activity uses fixed phase plus sanitized tool name. Every preview is independently byte-bounded and terminal-control-sanitized.

### All jobs

`subagent_status({})` returns compact two-line entries. Active jobs come first, followed by collectable jobs, then collected and discarded history. Stable ordering within each group is preserved.

Each entry includes:

- ID, state, and elapsed/final duration.
- Bounded task preview.
- Latest bounded activity summary when available.

The response includes at most 20 jobs and states how many were omitted. The complete model-visible response remains under the existing 50 KiB output limit.

### Compatibility

- Existing `{}` and `{ id }` inputs remain valid.
- No new tool is added.
- `subagent_wait` remains state-only and does not inherit richer status payloads.
- Existing job details may remain in internal tool details for renderer compatibility, but model-visible content must stay bounded.

## Dashboard behavior

### List mode

The dashboard keeps grouped `QUEUED`, `RUNNING`, and `INBOX` sections. Rows show:

- Selection marker.
- Job ID.
- Write marker when relevant.
- State and elapsed/final duration.
- Bounded task preview.
- Latest short activity when space allows.

Collected and discarded jobs remain outside the dashboard, matching the existing inbox behavior.

### Compact detail mode

`Enter` toggles compact details for the selected job. This mode shows:

- Task.
- Profile and access.
- Launch and reported model.
- Created, started, and finished times.
- Queue/run duration.
- Usage.
- Latest three bounded activity entries.
- Capture and error indicators.
- A hint that `v` opens the full view.

It never renders complete output, stderr, errors, or malformed samples.

### Full view mode

`v` opens a full-detail view for the selected job. This view includes:

- All compact metadata.
- Captured output.
- Stderr and error diagnostics.
- Truncation notices.
- Malformed protocol samples.
- Recent progress information.

The content may be long in memory, but rendering is a viewport. The component receives the current terminal-row count from the TUI factory and reserves rows for its title and footer. It returns no more than the computed viewport height.

The footer reports the visible range, for example:

```text
lines 41–62 of 310
```

Scroll position is clamped after job updates and terminal resizes. If the selected job ceases to be visible because the parent collects or discards it, the dashboard returns to list mode and selects the nearest remaining job.

### Controls

```text
↑/↓       Select job, or scroll one line in full view
Enter     Toggle compact details
v         Open or close full view
PgUp/PgDn Scroll full view by one page
Home/End  Jump to the start or end of full view
c         Cancel a queued or running job
Esc       Return from full view; otherwise close dashboard
```

The dashboard has no collect or discard controls. It never sends a result message into the session.

## Rendering and lifecycle rules

### Progress-driven rendering

Remove the one-second dashboard interval entirely. The dashboard rerenders only for:

- Render-relevant manager changes, such as state transitions, tool phases, usage, or the selected job changing.
- User navigation or mode changes.
- Terminal resize/invalidation performed by Pi.

The manager can publish a snapshot for every streamed assistant text delta. The dashboard must compare a small render fingerprint and ignore updates that change only an in-progress text delta. It still keeps the newest snapshot so the next user action, tool event, or terminal state renders current data. This prevents token-rate full-screen redraws without adding a throttle timer.

Elapsed time is calculated at render/projection time. It may remain visually unchanged during a quiet long-running tool until the next render-relevant update. Stability is more important than a ticking clock.

### Explicit active-dashboard cleanup

`registerSubagentsUi()` tracks the active dashboard close operation. Its returned cleanup function must:

1. Close and dispose an open dashboard.
2. Unsubscribe its manager listener.
3. Clear the compact widget subscription and widget.
4. Be idempotent.

Disposed dashboard methods and stale callbacks must become no-ops. No callback may call `requestRender()` after disposal.

### Terminal text safety

Before child-controlled text enters dashboard rendering, normalize it to safe display text:

- Preserve ordinary Unicode, newlines, and supported color/style SGR sequences only where needed.
- Remove carriage returns, cursor movement, erase commands, title changes, and other terminal-control sequences.
- Apply UTF-8-safe byte and character bounds to previews.
- Continue applying ANSI-aware width truncation to every rendered line.

The full view displays sanitized captured content, not raw terminal control bytes.

## Error handling

- Unknown status IDs retain the existing actionable diagnostic.
- Missing timestamps omit unavailable durations.
- Negative durations caused by clock skew clamp to zero.
- Missing progress shows `No activity reported yet` rather than misleading values.
- Missing usage displays zero only when zero is the actual accumulated snapshot.
- A full view with no output shows a clear placeholder.
- Full-view scroll offsets clamp when content shrinks.
- Cancelling a no-longer-cancellable job shows the existing dashboard error and refreshes from manager state.
- Dashboard cleanup remains safe when called more than once or while cancellation is pending.

## Testing strategy

### Pure status projection

Test:

- Every job state.
- Queue, running, and final durations with an injected clock.
- Missing and skewed timestamps.
- Launch versus reported model.
- Usage formatting.
- Recent activity selection and ordering.
- Preview byte bounds and Unicode safety.
- Exclusion of complete output, stderr, errors, malformed samples, and prompts.
- Twenty-job aggregate cap and omitted count.

### Dashboard rendering

Test:

- Width bounds across narrow and wide terminals.
- Height bounds with a 50 KiB multiline output.
- Compact and full modes.
- One-line, page, start, and end scrolling.
- Scroll clamping after resize and content shrink.
- Selection preservation after manager updates.
- External collection/discard while a job is selected.
- Absence of collect/discard keys and message delivery.
- Existing cancellation eligibility and race handling.

### Corruption regressions

Test:

- Construction with a running job creates no refresh interval.
- Repeated passage of wall-clock time alone requests no renders.
- Token-by-token assistant text updates do not request token-rate renders, while the latest snapshot is retained.
- Tool lifecycle and state changes still request a render.
- A captured stale callback after disposal requests no render.
- Session cleanup closes an unresolved custom dashboard and removes subscriptions.
- Child text containing carriage return, OSC, `ESC[2J`, `ESC[H`, `ESC[K`, tabs, emoji, combining marks, and CJK cannot exceed width or emit unsafe controls.
- Rendered line count never exceeds the supplied terminal-row budget.

### Verification

Run:

```sh
npm test
npm run typecheck
```

Where practical, run a real Pi smoke test with `PI_TUI_WRITE_LOG` enabled:

1. Start a background job that produces progress and multiline output.
2. Open `/subagents` while Pi's parent working indicator is active.
3. Switch among list, compact, and full modes.
4. Scroll and resize the terminal.
5. Close, reopen, reload, and exit with the dashboard open.
6. Confirm there are no duplicate `Working...` rows, drift, stale redraws, or raw cursor-control effects.

## Documentation

Update `README.md` to:

- Show the richer `subagent_status` output.
- Document the revised dashboard controls.
- State that dashboard collection and discard were removed.
- Explain that the parent agent remains responsible for collecting or discarding results.

## Success criteria

- A single status call explains what a job is doing without exposing its complete answer.
- Status and dashboard agree on shared state, timing, model, usage, and activity facts.
- The dashboard never renders more lines than its viewport budget.
- No timer-driven dashboard redraw remains.
- Dashboard cleanup closes all active callbacks during session teardown.
- Child output cannot emit terminal cursor or erase commands through the dashboard.
- `/subagents` no longer collects, discards, or injects results.
- Existing job lifecycle and tool interfaces remain compatible.
