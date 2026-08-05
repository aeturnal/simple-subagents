# Live Widget Priority Details Design

## Summary

Keep the live subagent widget's ending details visible when terminal width is limited. Treat the task text as the flexible part of each row, add the selected model to the ending details, publish turns, tokens, and the observed model while jobs are still running, and extend terminal-job visibility from three seconds to five seconds.

## Goals

- Preserve the complete detail suffix whenever the terminal can fit the fixed row prefix and suffix.
- Truncate the task before truncating any detail.
- Show live turn count, tool-use count, token count, model, thinking level, and duration in a stable order.
- Update turns, tokens, and observed model after each completed assistant response.
- Keep completed, failed, and cancelled jobs visible for five seconds.
- Keep every rendered line within the supplied terminal width.

## Non-goals

- Changing the `/subagents` dashboard layout.
- Changing process launch model or thinking selection.
- Counting cached tokens a second time.
- Updating usage for every streamed token.
- Changing job lifecycle, collection, discard, cancellation, or concurrency behavior.
- Making the widget horizontally scrollable or adding multi-line statistics.

## Job Row Layout

Each primary job row has three logical parts:

1. A fixed prefix containing the tree connector, state icon, agent name, and existing spacing.
2. Flexible task text.
3. A reserved detail suffix.

The detail fields appear in this order:

```text
↻turns · tool uses · tokens · model · thinking · duration
```

A representative row is:

```text
└─ ⠹ coder  Revise ONLY `docs/superpowers/specs/2026-08- · ↻2 · 19 tool uses · 21.6k tokens · gpt-5.6-sol · high · 357.7s
```

Existing omission rules remain:

- Omit turns when zero.
- Omit tool uses when zero.
- Omit tokens when zero.
- Omit model when neither an observed model nor launch model is known.
- Omit thinking when no explicit launch thinking level is known.
- Always show duration, with the existing `queued` prefix for queued jobs.

The same row layout applies to running, queued, and lingering terminal jobs. Existing state styling, connectors, ordering, activity child lines, and heading behavior remain unchanged.

## Width Allocation

Rendering computes the styled fixed prefix and plain logical task and suffix independently. ANSI-aware visible width, not JavaScript string length, controls allocation.

The allocator follows this priority:

1. Keep the fixed prefix.
2. Keep the complete detail suffix.
3. Give all remaining columns to the task.
4. Truncate the task with Pi TUI's width-aware ellipsis when it does not fit.
5. Omit the task and its separating space when no task columns remain.
6. Only when the fixed prefix and complete suffix cannot fit together, shorten the suffix from its left side so the final fields remain visible.
7. At widths too small even for the fixed prefix, apply the existing ANSI-aware final width bound without throwing.

The row must never exceed the supplied terminal width. Task truncation must remain correct for ANSI styling, emoji, and wide characters. Changes in duration or live usage may reduce or increase the task allocation on later redraws without changing field priority.

## Model Display

The widget chooses the model label in this order:

1. The model reported by the latest completed assistant message.
2. The resolved launch model stored on the job.
3. No model field.

The display label removes the provider path and keeps the final slash-delimited segment. For example:

```text
openai-codex/gpt-5.6-sol -> gpt-5.6-sol
```

This transformation is presentation-only. Stored model identifiers and launch behavior remain unchanged. A model identifier without a slash is displayed unchanged.

## Live Usage and Model Updates

### Runner callback

Extend the process-run contract with a dedicated live telemetry callback. Its payload contains an immutable snapshot of accumulated `UsageStats` and the latest observed model when known.

After every assistant `message_end` event, the runner:

1. Increments accumulated turns once.
2. Adds the message's input, output, cache-read, cache-write, and cost values using the existing parsing rules.
3. Updates the observed model when the message supplies one.
4. Emits a cloned telemetry snapshot.

Token display remains `usage.input + usage.output`. Cache counters are retained for existing reporting but are not added again to the widget token count.

Telemetry is emitted once per completed assistant message, not for text or thinking deltas. Missing or malformed numeric fields continue to add zero.

### Manager update

`JobManager` accepts telemetry alongside progress during process startup. It safely handles a runner that invokes the callback synchronously by buffering the latest pre-registration telemetry, following the existing synchronous progress handling pattern.

For a running job, the manager replaces `job.usage`, updates `job.model` when supplied, and notifies subscribers. Updates for jobs that no longer accept process updates are ignored. Snapshots sent to callers remain cloned and immutable.

The final `ProcessResult` remains authoritative. Existing result application replaces usage and model with the final accumulated values, preserving current settlement behavior.

## Five-Second Terminal Linger

Change the terminal linger duration from 3,000 ms to 5,000 ms.

A completed, failed, or cancelled job is visible while:

```text
now < finishedAt + 5000ms
```

It disappears exactly at the five-second boundary. Collected and discarded jobs still disappear immediately. The controller continues scheduling one timeout for the nearest expiry and does not add polling.

## Error and Edge Handling

- Zero and negative token totals remain clamped safely by existing formatting behavior.
- Missing telemetry does not prevent process completion or widget rendering.
- A missing observed model falls back to the launch model.
- Unknown model strings remain opaque except for presentation-only removal of preceding slash-delimited path segments.
- A width of zero or a width smaller than the connector must not throw.
- Every returned line must satisfy the terminal's visible-width bound.
- Late telemetry cannot revive or mutate a settled, collected, or discarded job.
- Existing bounded progress capture and tool-use counting remain unchanged.

## Files and Responsibilities

- `src/process-runner.ts`: define and emit live telemetry snapshots.
- `src/job-manager.ts`: buffer, apply, clone, and notify live telemetry.
- `src/live-widget.ts`: format model details, allocate row width by priority, preserve the suffix tail, and use a five-second linger.
- `test/process-runner.test.ts`: verify per-message telemetry and accumulation.
- `test/job-manager.test.ts`: verify running snapshots update before settlement and final results remain authoritative.
- `test/live-widget.test.ts`: verify field order, model fallback, width priority, Unicode safety, and five-second boundaries.
- `README.md`: briefly document the priority detail suffix and five-second terminal linger.

## Testing Strategy

Follow test-driven development.

### Process runner

Test that:

- One assistant `message_end` emits turns, tokens, and model immediately.
- Multiple assistant messages accumulate usage and update the observed model.
- Text and thinking delta events do not emit telemetry.
- Missing usage fields contribute zero.
- The final result equals the last accumulated telemetry values.

### Job manager

Test that:

- A running job snapshot receives live usage and model before process settlement.
- Subscribers are notified after telemetry updates.
- Synchronous telemetry during runner startup is not lost.
- Telemetry payloads cannot mutate manager state after callback return.
- Late updates after settlement are ignored.
- Final result application remains authoritative.

### Live widget

Test that:

- Detail order is turns, tool uses, tokens, model, thinking, then duration.
- The observed model takes precedence over the launch model.
- The launch model appears before observed telemetry exists.
- Provider paths are removed only in the displayed model label.
- The complete suffix remains visible while task text shrinks.
- The task becomes an ellipsis and then disappears before suffix truncation.
- An overlong suffix is shortened from the left and preserves its final fields.
- ANSI styling, emoji, and wide characters never exceed terminal width.
- Terminal jobs remain visible immediately before five seconds and disappear exactly at five seconds.
- Existing activity lines, ordering, state icons, timers, and cleanup remain unchanged.

## Verification

Run:

```sh
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts test/live-widget.test.ts
npm test
npm run typecheck
```

Run LSP diagnostics on all edited TypeScript files and session diagnostics before completion.

## Success Criteria

- A normal narrow terminal preserves the complete ending detail block and truncates only the task.
- Turns and tokens become visible while a multi-turn subagent is running.
- The model appears as a short label such as `gpt-5.6-sol`.
- Finished jobs remain visible for five seconds.
- Extremely narrow terminals preserve the rightmost available details without exceeding width.
- Existing lifecycle, dashboard, process result, and cleanup behavior remain intact.
