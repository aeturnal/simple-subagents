# 05 — Richer Bounded Subagent Status Design

## Summary

Make an occasional `subagent_status` call informative without exposing uncollected answers. Single-job status will show timing, profile, access, model information, cancellation intent, final usage when available, and a short tail of recent tool or diagnostic activity. Multi-job status remains compact.

This feature is independently releasable. It becomes more precise when per-job model overrides are installed but does not require them.

## Goals

- Explain whether a running job appears active without returning its answer.
- Show queue and run timing.
- Show profile, access mode, model information, and cancellation intent.
- Return at most three recent bounded activity events.
- Keep all-job status concise and bounded.
- Preserve existing status calls.

## Non-goals

- Returning final output, stderr, or partial assistant prose.
- Detecting or declaring that a job is stuck.
- Streaming live usage through new runner infrastructure.
- Persisting progress.
- Replacing the interactive dashboard.
- Changing job lifecycle semantics.

## Public interface

Extend the existing schema additively:

```ts
subagent_status({
  id: "job-4",
  progressLimit: 3
})
```

`progressLimit`:

- Is optional.
- Is an integer from 0 through 3.
- Defaults to 1 for single-job status.
- Is rejected when supplied without `id`, because all-job listings never include progress tails.

Existing `{}` and `{ id }` calls remain valid.

## Single-job status view

The model-visible view contains:

- Job ID.
- Process state.
- Agent profile name.
- Read-only or write access.
- Created, started, and finished timestamps when available.
- Queue duration.
- Current or final run duration.
- Resolved, configured, inherited, or reported model information when available.
- Whether cancellation was requested.
- Final usage and turn count when available.
- Latest progress timestamp.
- Up to `progressLimit` recent sanitized public activity items.

Example:

```text
job-4: running
Agent: reviewer
Access: read-only
Elapsed: 18.4s
Model: anthropic/claude-sonnet-4-5
Latest progress: 2.1s ago
Recent activity:
- Started read
- Completed read
```

Durations use the manager’s injected clock for deterministic behavior. Running durations use `now - startedAt`; terminal durations use `finishedAt - startedAt`; queue duration uses `startedAt - createdAt` when started.

## Public progress boundary

Raw `ProgressItem.text` is never a public status source, regardless of whether its type is `text`, `tool`, or `diagnostic`. Tool and diagnostic text is opaque and may contain arguments, paths, results, errors, or model-generated prose.

Extend eligible progress records with an optional, separately generated `publicSummary`. The process runner constructs tool summaries only from an allowlisted event phase and sanitized tool name, such as `Started read` or `Completed grep`; it never includes arguments or results. Diagnostic summaries use fixed extension-owned codes and phrases, never raw stderr, parser samples, exception messages, or provider text. Status ignores every progress item without `publicSummary`.

Each public summary is UTF-8-safe and capped at 512 bytes at creation and formatting boundaries. At most three summaries are emitted, newest last, from the manager’s already-bounded progress history. Status reports the latest progress time even when the latest item has no public summary, but not its contents.

Final output, partial text, raw tool activity, stderr, error messages, malformed samples, and collected bodies never enter status content or public status DTOs.

## Multi-job status

`subagent_status({})` continues returning compact ID/state summaries. It may add small timing or agent fields only if the complete line remains concise. It never includes progress tails.

Model-visible status content remains capped at 50 KiB. Whole job lines are included in stable job order until the reserved limit is reached, followed by an omitted-job count. No line is cut mid-character.

## Cancellation visibility

Expose cancellation intent on public job snapshots:

```ts
cancellationRequested: boolean;
```

The manager already tracks this internally. The public field is set when cancellation begins and remains true through the resulting terminal state. This does not add a new state or change race resolution.

## Model visibility

When the model-override feature is present, status uses `resolvedModel` and `resolvedThinkingLevel`. Without it, status shows the best-known model in this order:

1. `job.model`, which may be either the launch selection or a value later reported by Pi.
2. Explicit profile model.
3. `inherits parent` when only inheritance is known.

Without Design 4, status does not claim provenance it cannot distinguish. The status feature does not independently add model resolution or live model validation.

## Usage visibility

Add `usageRecorded: boolean` to public job snapshots. It starts false and becomes true when `JobManager.applyResult()` records a process result, even when every usage counter is legitimately zero. Usage and turn count are shown only when `usageRecorded` is true; otherwise status shows `Usage: not yet available` or omits the line. This feature does not add callbacks for live token accounting.

## Architecture

Add a pure formatter that maps a `Job` snapshot and current time to a bounded public status view. Model-visible `content` and custom rendering consume this view.

Existing internal `details.jobs` remains for renderer and compatibility needs; its presence means the 50 KiB guarantee applies to model-visible `content`, not the complete internal tool-result object. Add `details.statuses` containing only bounded public DTOs, and use those DTOs for new rendering. No private output is copied into `statuses`, and no existing detail field is renamed.

The dashboard may reuse duration and activity formatting helpers, but no dashboard layout redesign is required.

## Rendering

Compact tool rendering keeps one line per job. Expanded single-job rendering shows the richer fields and recent activity. Missing optional values are omitted or labeled `not yet available`; they are never rendered as misleading zeroes.

All lines remain ANSI-aware and width-constrained in the TUI.

## Error handling

- Unknown IDs retain the existing actionable error.
- `progressLimit` without `id` returns a validation diagnostic.
- Invalid limits fail schema validation.
- Missing timestamps do not produce negative durations.
- Clock skew clamps displayed durations to zero.
- Oversized or multibyte progress is truncated safely.
- Private progress and output are excluded even when requested limits are nonzero.

## Testing strategy

Tests cover:

- Queued, running, and every terminal state.
- Queue, elapsed, and final duration calculations with an injected clock.
- Clock skew and missing timestamps.
- Default, zero, and maximum progress limits.
- Public-summary production, allowlisting, filtering, and ordering.
- Proof that raw tool arguments, results, diagnostics, and progress text are never used by status.
- UTF-8-safe per-item truncation.
- Cancellation requested before and after terminal transition.
- Usage recorded, unavailable, and legitimately all-zero.
- Model information with and without model overrides.
- Large all-job listings and omitted counts.
- Absence of partial output, final output, stderr, errors, and malformed samples.
- Legacy status inputs.
- Compact, expanded, and narrow-width rendering.

## Documentation

The README will show a richer status example and emphasize that status reports activity metadata, not the subagent’s answer.

## Success criteria

- One status check explains basic progress and timing.
- No uncollected answer text leaks into model-visible status.
- Status output remains bounded for one or many jobs.
- Existing status calls and job states remain compatible.
- No new live-usage or stuck-detection subsystem is introduced.
