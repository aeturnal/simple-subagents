# Final Fix Report: Legacy Persisted Start Details

## Summary

Fixed expanded `subagent_start` rendering for legacy persisted tool results. The renderer now accepts either the current `PublicJobDetail` or a prior full `Job` snapshot. For the legacy shape only, it reads `request.task` through `boundedPreview`, which strips terminal controls and applies the existing preview bounds. Current tool-result generation remains unchanged and continues to emit only `PublicJobDetail` records.

## Changed files

- `src/tools.ts`
  - Allowed launch-detail rendering to read legacy full `Job` snapshots.
  - Used the existing bounded/sanitized preview for the legacy `request.task` fallback.
  - Narrowed the launch-thinking input to the common launch-selection fields so both shapes typecheck.
- `test/tools.test.ts`
  - Added a renderer regression test using a legacy persisted start-result shape with an oversized terminal-control task.
  - The test verifies the legacy task renders, `undefined` and escape controls do not render, and the fallback is grapheme-bounded.
- `.superpowers/sdd/2026-08-05-private-job-boundary/final-fix-report.md`
  - This report.

## Root cause

The persistence-boundary change made newly generated detail jobs use `job.task`. Existing persisted start results instead contain full `Job` values, where the task is stored at `job.request.task`. Expanded rendering therefore displayed `undefined` for those historical results.

## Red/green evidence

### Red

Command:

```sh
npx tsx --test --test-name-pattern='start renderer reads bounded task detail from a legacy persisted job' test/tools.test.ts
```

Result: failed as expected (exit 1). The renderer output contained `  undefined` and did not contain `legacy persisted task`.

### Green

Command:

```sh
npx tsx --test --test-name-pattern='start renderer reads bounded task detail from a legacy persisted job' test/tools.test.ts && npm run typecheck
```

Result: passed. The focused test passed (1 test, 0 failures), and `tsc --noEmit` exited 0.

## Verification

Commands run:

```sh
npx tsx --test test/tools.test.ts && npm run typecheck && git diff --check
```

Result: passed. Tool tests: 40 tests, 0 failures. Typecheck exited 0. `git diff --check` reported no whitespace errors.

```sh
npm test && git diff --check
```

Result: passed. Full suite: 217 passed, 0 failed, 2 skipped. `git diff --check` reported no whitespace errors.

## Self-review

- Confirmed the fallback exists only in read-time renderer logic.
- Confirmed legacy task text is passed through the existing terminal sanitizer and byte/grapheme bounds.
- Confirmed current response construction still maps live jobs through `toPublicJobDetail` at every tool-detail construction path.
- Confirmed no persistence-boundary behavior or unrelated code changed.

## Fix commit

`27f1509aab8d2223bb1f2c70e395dfe5cd4a231e` — `fix: render legacy persisted start details`

## Concerns

None.
