# Final fix wave report — richer status dashboard

## Scope

Addressed both final-review findings with four production-line changes and three focused regressions. No unrelated code was changed.

## Root-cause findings

1. `renderFingerprint()` serialized each assistant text progress item's complete truncation metadata. Once partial assistant text had reached the 50 KiB capture limit, each new delta increased `truncation.originalBytes` while the retained text and `keptBytes` stayed unchanged. That changed the fingerprint and requested a render for every delta.
2. `projectJobStatus()` used `startedAt` as every non-queued job's queue end. A job cancelled before it started has no `startedAt`, despite having `createdAt` and terminal `finishedAt`, so its queue duration was missing. Dashboard `stateText()` selected only run duration for terminal states.

## TDD evidence

### RED

Added these regressions before production changes:

- `test/dashboard.test.ts`: `post-limit assistant deltas do not redraw when only original bytes grow`
  - Uses a 50 KiB retained assistant text snapshot and two later deltas whose only fingerprint-relevant former difference is `originalBytes` (`51201`, `51202`, `51203`) while `keptBytes` remains `51200`.
- `test/job-status.test.ts`: `projects a terminal queued job duration from creation to finish`
  - Uses a cancelled job with `createdAt: 1000`, no `startedAt`, and `finishedAt: 7000`; expects a `6000` ms queue duration and no run duration.
- `test/dashboard.test.ts`: `terminal queued cancellation shows its queue duration in the dashboard`
  - Expects the dashboard row to render `cancelled 2s` for a pre-start terminal cancellation.

Command:

```sh
npx tsx --test --test-name-pattern='post-limit assistant deltas|terminal queued cancellation|projects a terminal queued job' test/dashboard.test.ts test/job-status.test.ts
```

Observed expected failures (3 failures):

- Redraw regression: `2 !== 0` render requests.
- Dashboard duration regression: rendered `> job-1 cancelled` with no duration.
- Projection regression: `queueDurationMs` was `undefined`, not `6000`.

### GREEN

Minimal production changes:

- `src/dashboard.ts`
  - Fingerprint assistant text truncation state as either absent or `{ keptBytes }`; it no longer includes the growing `originalBytes` value.
  - Preserve all other capture/truncation fingerprint fields unchanged.
  - Fall back from missing run duration to queue duration in dashboard state text.
- `src/job-status.ts`
  - For a terminal job without `startedAt`, use `finishedAt` as the queue end.

The same focused RED command then passed all 3 tests.

## Verification evidence

Focused suite:

```sh
npx tsx --test test/dashboard.test.ts test/job-status.test.ts
```

Result: 33 passed, 0 failed.

Full suite, typecheck, and whitespace diff check:

```sh
npm test && npm run typecheck && git diff --check
```

Results:

- `npm test`: 201 passed, 0 failed, 2 skipped.
- `npm run typecheck`: passed (`tsc --noEmit`).
- `git diff --check`: passed with no output.

## Self-review

Reviewed the complete patch with `git diff`.

- The redraw regression changes only `originalBytes` across multiple post-limit snapshots, so it fails against the old fingerprint and proves the intended suppression.
- A truncation transition and `keptBytes` changes still alter the fingerprint. Output, stderr, error, and job-level truncation metadata remain fingerprinted in full, so real capture changes outside in-progress assistant text still redraw.
- Terminal jobs that did start still use `startedAt` for queue duration and retain their run duration. Only terminal jobs missing `startedAt` use `finishedAt` as queue end.
- The dashboard test exercises the visible fallback, rather than only the internal projection.
- No abstractions, dependencies, or unrelated refactors were added.

## Files changed

- `src/dashboard.ts`
- `src/job-status.ts`
- `test/dashboard.test.ts`
- `test/job-status.test.ts`
- `.superpowers/sdd/2026-08-01-richer-status-dashboard/final-fix-report.md`

## Concerns

No code concerns found. The optional interactive Pi/TUI smoke test was not run in this non-interactive session; automated dashboard coverage passed.
