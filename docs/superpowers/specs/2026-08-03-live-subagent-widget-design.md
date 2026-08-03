# Live Subagent Widget Design

## Summary

Replace the automatic one-line subagent count with an animated tree widget inspired by `tintinweb/pi-subagents`. Keep the existing `/subagents` dashboard unchanged.

The widget shows queued and running jobs, brief live activity, compact usage statistics, and terminal outcomes for three seconds. It installs once per Pi session and requests redraws from the existing TUI component instead of replacing the widget on every update.

## Goals

- Make active subagents visible without opening `/subagents`.
- Match the visual language of `pi-subagents`: tree connectors, Braille spinner, status icons, activity child lines, turns, tool uses, tokens, and duration.
- Keep every rendered line within terminal width.
- Keep completed, failed, and cancelled jobs visible for three seconds.
- Stop all animation and expiry timers when they are not needed.
- Preserve the existing dashboard, lifecycle, tools, process capture, and result behavior.

## Non-goals

- Adding a navigable fleet list.
- Adding a conversation viewer.
- Capturing a complete child conversation.
- Steering, resuming, or continuing a child.
- Changing `/subagents` controls or layout.
- Changing job limits, lifecycle transitions, collection, or discard.
- Adding context-window percentages or compaction counts, which the current child protocol does not expose.

## Reference and adaptation

The visual reference is `tintinweb/pi-subagents` at commit `2966cd5a33c0640de9698b56a39c11f83207a835`.

The reference keeps an in-process child session with richer live state. `simple-subagents` launches child Pi processes and retains bounded `ProgressItem` snapshots instead. The adapted widget therefore uses only existing safe facts:

- Profile name and task from the job request.
- State and timestamps from `Job`.
- Turns and token totals from `UsageStats`.
- Tool-use count from `Started …` tool progress events.
- Latest activity from the bounded, sanitized status projection.

No new capture or process protocol is required.

## Appearance

A representative active widget is:

```text
● Subagents
├─ ⠹ reviewer  Review authentication · ↻2 · 3 tool uses · 12.4k tokens · 8.1s
│    ⎿ Started read
├─ ○ generic   Update documentation · queued 2.3s
└─ ✓ reviewer  Check tests · 4.1k tokens · 5.7s
```

### Heading

- Use `● Subagents` in the accent color while any queued or running job exists.
- Use `○ Subagents` in the dim color when only lingering terminal jobs remain.
- Render nothing when no job is displayable.

### Ordering

Display jobs in three stable groups while preserving manager order within each group:

1. Running.
2. Queued.
3. Terminal jobs still inside the linger window.

Never display collected or discarded jobs.

### State icons

- Running: the current Braille spinner frame in the accent color.
- Queued: `○` in the muted color.
- Completed: `✓` in the success color.
- Failed: `✗` in the error color.
- Cancelled: `■` in the dim color.

Use `├─` for every job except the last and `└─` for the last job. A running job with activity receives one indented `⎿` child line. The child line keeps or removes its vertical continuation according to whether later jobs exist.

### Labels and statistics

- Render the profile name in bold for running jobs and dim or muted for non-running jobs.
- Render the bounded task preview after two spaces.
- Separate statistics with ` · `.
- `↻N` is the accumulated assistant turn count and is shown when greater than zero.
- Tool uses count only `ProgressItem` entries whose type is `tool` and whose text starts with `Started `.
- Tokens equal `usage.input + usage.output`; cache counters are not added a second time.
- Show compact token values such as `950 tokens`, `12.4k tokens`, and `1.2M tokens`.
- Show duration with one decimal second. Queued rows prefix it with `queued `.
- Clamp negative durations to zero.
- Omit zero turn, tool-use, and token fields. Always show duration.

### Activity

Only running jobs receive an activity child line. Use the latest entry from `projectJobStatus(job, now).recentActivity`, which is already terminal-safe and bounded. If no activity exists, show `thinking…`.

### Width

Pass every complete row through Pi TUI's ANSI-aware `truncateToWidth`. Rendering must return no line whose visible width exceeds the supplied terminal width, including widths smaller than the heading or connector.

The existing maximum batch size of eight bounds widget height. This change adds no separate scrolling or overflow interface.

## Three-second terminal linger

A terminal job is visible when:

```text
finishedAt is present and now - finishedAt < 3000ms
```

At exactly 3000 ms it disappears. A negative age caused by clock skew remains visible until the deadline. Terminal jobs that were collected or discarded disappear immediately regardless of age.

A session that starts with old terminal jobs does not replay them. A recently finished job may appear for only the unexpired remainder of its three-second window.

## Module boundary

Create `src/live-widget.ts` with two responsibilities behind a small interface.

### Pure presentation

```ts
export interface LiveWidgetRenderOptions {
  readonly now: number;
  readonly frame: number;
  readonly width: number;
  readonly theme: LiveWidgetTheme;
}

export function formatLiveWidgetLines(
  jobs: readonly Job[],
  options: LiveWidgetRenderOptions,
): string[];
```

This function owns filtering, stable grouping, tree connectors, statistics, activity selection, styling, and width truncation. It has no timers, manager, TUI context, or mutation.

### Stateful redraw controller

```ts
export class LiveSubagentsWidget {
  constructor(options?: LiveSubagentsWidgetOptions);
  setUi(ui: LiveWidgetUi): void;
  setJobs(jobs: readonly Job[]): void;
  dispose(): void;
}
```

The controller owns widget registration, the current immutable job snapshots, one animation interval, one linger-expiry timeout, and the captured TUI redraw handle. It does not own job lifecycle or dashboard behavior.

`LiveSubagentsWidgetOptions` supplies `now`, interval, timeout, and clearing functions for deterministic tests. Production defaults use `Date.now`, `setInterval`, `clearInterval`, `setTimeout`, and `clearTimeout`.

## Rendering lifecycle

### Registration

`registerSubagentsUi` creates one `LiveSubagentsWidget` for the active Pi session and gives it the session UI. The manager subscription passes snapshots to `setJobs`.

The controller calls `setWidget("simple-subagents", factory, { placement: "aboveEditor" })` only when the first displayable job appears. Later job and animation changes call `tui.requestRender()` on the existing component. This avoids layout churn from repeated widget replacement.

When no displayable job remains, clear the widget and release the captured TUI reference.

### Animation

Use the ten-frame Braille sequence:

```text
⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
```

Run one 80 ms interval while at least one job is running. Each tick advances the frame and requests a TUI render. Stop the interval immediately when no running job remains.

Streaming text updates only replace the stored snapshot while animation is active; the next animation frame presents the latest activity. They do not independently request token-rate redraws. State transitions and updates without a running animation request one immediate redraw.

### Linger expiry

When terminal rows are visible, schedule one timeout for the nearest `finishedAt + 3000` deadline. On expiry, recompute visibility, request a render or clear the widget, and schedule the next deadline if needed.

Do not poll terminal rows with an interval.

### Cleanup

On session replacement or extension cleanup:

1. Unsubscribe the manager listener.
2. Dispose the live widget.
3. Clear its animation interval.
4. Clear its linger timeout.
5. Remove the widget.
6. Ignore stale timer callbacks.

Cleanup is idempotent.

## Existing dashboard isolation

`SubagentsDashboard` remains progress-driven and timer-free. Its one-line widget formatter is replaced by the new live widget, but its custom full-screen component, keyboard controls, render fingerprint, selection, cancellation, viewport, and output inspection remain unchanged.

This distinction is intentional: the earlier flicker issue came from timer-driven redraws of the full-screen custom dashboard competing with Pi's working renderer. The new timer redraws only the small above-editor widget and reuses one installed component, following the reference implementation's safe pattern.

## Error and edge handling

- Sanitize labels and activity through the existing bounded status projection before rendering.
- Missing `startedAt` uses `createdAt` as the duration start.
- Missing `finishedAt` prevents a terminal row from lingering.
- Empty tasks or profile names remain safe bounded strings.
- A width of zero returns empty strings only if required by `truncateToWidth`; it must not throw.
- Repeated `setJobs`, `setUi`, and `dispose` calls must not duplicate timers or widget registration.
- Timer callbacks after disposal do nothing.
- A replaced session cannot redraw the old TUI.

## Testing strategy

Follow test-driven development.

### Pure formatting

Test:

- Heading and stable running, queued, terminal ordering.
- Every icon and state color role.
- Spinner frame selection and wraparound.
- Turns, singular/plural tool uses, compact tokens, and one-decimal durations.
- Tool-use counting excludes update, completion, and result events.
- Latest bounded activity and `thinking…` fallback.
- Three-second linger before and at the exact boundary.
- Collected and discarded exclusion.
- Negative-duration clamping.
- Visible-width bounds for narrow and wide terminals.
- Correct final tree connectors and running activity indentation.

### Controller

Use injected fake timers and a fake UI/TUI to test:

- Widget registration happens once when work appears.
- Later changes request render rather than replace the widget.
- One animation interval starts for running jobs and advances frames.
- Streaming updates do not add independent redraws while the interval is active.
- Animation stops on the final running transition.
- One timeout targets the nearest linger deadline.
- Expiry clears finished rows and eventually removes the widget.
- Collected or discarded transitions remove rows immediately.
- Disposal clears both timer kinds and makes stale callbacks inert.

### Integration

Update dashboard registration tests to verify:

- Session start wires manager snapshots into the live widget.
- Session replacement disposes the previous widget before subscribing the next session.
- Extension cleanup removes the widget before manager shutdown.
- `/subagents` behavior remains covered by its existing tests.

## Documentation

Update `README.md` near the usage overview to describe the automatic animated tree, the three-second terminal linger, and the fact that `/subagents` remains the durable inbox view.

## Verification

Run:

```sh
npx tsx --test test/live-widget.test.ts test/dashboard.test.ts
npm test
npm run typecheck
```

Run LSP and project diagnostics for edited TypeScript files before completion.

## Success criteria

- Active subagents are understandable from the automatic widget without opening the dashboard.
- The widget visually follows `pi-subagents` while using only data already captured by this project.
- Running animation is smooth and uses one installed component.
- Finished rows remain for three seconds and then disappear.
- No timer survives when it is unnecessary or after cleanup.
- Every rendered line respects terminal width.
- `/subagents`, tools, process behavior, and lifecycle semantics remain unchanged.
