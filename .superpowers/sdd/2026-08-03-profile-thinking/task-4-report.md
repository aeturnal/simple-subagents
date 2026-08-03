# Task 4 Report: Resolve Thinking and Reject Suffixed Job Models Atomically

## Status
Complete within the approved mechanical scope ruling.

## RED evidence
Recovered by temporarily restoring the pre-Task-4 production files from `HEAD`, running the requested focused suite, then restoring the Task 4 patch.

```text
npx tsx --test test/launch-options.test.ts test/job-manager.test.ts
60 tests: 55 passed, 5 failed
```

The failures were expected and directly covered the change:
- launch resolution still returned `path: "override"` instead of the path-free shape;
- legacy resolution returned `parent-model:high`, no separate thinking argument, and source `legacy` instead of clean model, `high`, and `parent`;
- a suffixed batch model did not reject;
- reserved job-model suffixes did not produce diagnostics.

Before the permitted process-runner fixture cleanup, `npm run typecheck` also failed with two `TS2353` errors because its typed `LaunchOptions` fixtures still supplied removed `path` properties.

## GREEN and verification summaries
- `npx tsx --test test/launch-options.test.ts test/job-manager.test.ts`
  - 60 passed, 0 failed.
- `npm run typecheck`
  - `tsc --noEmit` exited 0.
- Scoped `rg -n 'path: "(?:legacy|override)"|launchThinkingSource: "legacy"' src/launch-options.ts test/launch-options.test.ts test/job-manager.test.ts test/process-runner.test.ts`
  - no matches.
- `git diff --check`
  - exited 0 with no output before commit.
- `npx tsx --test test/process-runner.test.ts`
  - 26 passed, 1 failed. The remaining failure is the explicitly deferred legacy presentation assertion; see Concerns.

## Changed files
- `src/types.ts`
  - Added `profile` as a launch-thinking source. Kept the temporary `legacy` union member under the approved sequencing ruling.
- `src/launch-options.ts`
  - Removed `LaunchOptions.path` and legacy suffix construction.
  - Resolves thinking in job → profile → parent → model/Pi-default order.
  - Rejects reserved thinking suffixes only on basically valid per-job models.
- `test/launch-options.test.ts`
  - Added precedence, invalid-parent, suffix, and opaque-model coverage.
- `test/job-manager.test.ts`
  - Updated path-free parent resolution and added atomic suffixed-batch rejection coverage.
- `test/process-runner.test.ts`
  - Removed only the two stale `path` properties from typed `LaunchOptions` fixtures, as authorized.

No unrelated formatter rewrites were present, so none were restored.

## Commit
`81d9628 feat: resolve profile thinking explicitly`

## Self-review
- Resolver no longer returns `path` or produces `legacy`.
- Profile thinking is selected only after valid per-job thinking and before valid parent thinking.
- Invalid parent thinking quietly defers to Pi/model defaults.
- The manager checks all diagnostics before assigning IDs, mutating its job list, or starting the runner.
- Reserved suffix rejection uses the shared `modelThinkingSuffix` helper and leaves non-reserved colon-containing IDs opaque.
- The only change outside the four original files is the two-property typecheck cleanup explicitly approved by the user.

## Concerns
`test/process-runner.test.ts` still has the deferred test named `passes legacy launch options with child extension isolation`. It expects the old `ollama/llama3.1:8b:high` invocation, while Task 4 now correctly produces `--model ollama/llama3.1:8b --thinking high`. Updating its expected model example/title is a Task 6 presentation-consumer change and was explicitly out of scope. This leaves that focused test file at 26 passing and 1 failing until Task 6.

## Concern Resolution

The deferred process-runner concern was resolved with the approved narrow test correction.

### Commands and exact results

- `npx tsx --test test/process-runner.test.ts`
  - 27 tests: 27 passed, 0 failed, 0 cancelled, 0 skipped.
- `npm run typecheck`
  - `tsc --noEmit` exited 0.
- `git diff --check`
  - exited 0 with no output.
- `git diff -- test/process-runner.test.ts`
  - confirmed only the test title and inherited-thinking launch assertions changed.

### Commit

`86b16ff4328a5668d790c86a655990f6bfdb6461 test: update inherited thinking launch assertion`

### Concerns

None. The test now expects the clean model `ollama/llama3.1:8b`, separate `--thinking high`, no suffixed model argument, and exactly one `--no-extensions`. No production files were changed.
