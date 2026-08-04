# Task 2 Report

## Status
Implemented and committed Task 2: policy-aware start schemas and request conversion.

## Changed files
- `src/tools.ts`
  - Added shared start-task fields.
  - Added strict disabled and enabled TypeBox schemas.
  - Added `startParamsFor(allowThinkingOverrides)`.
  - Kept `StartParams` as the disabled safe default.
  - Added the default-false policy gate to `startJobs` and `registerSubagentTools`.
  - Stripped injected `thinkingLevel` values when overrides are disabled.
  - Preserved job thinking overrides when explicitly enabled.
- `test/tools.test.ts`
  - Added schema policy coverage.
  - Replaced the unconditional override test with disabled/enabled defense-in-depth coverage.
  - Updated safe-default request and registration assertions.

## RED evidence
Command:

```bash
npx tsx --test test/tools.test.ts
```

Result: failed before running tests because `startParamsFor` was not exported:

```text
SyntaxError: The requested module '../src/tools.ts' does not provide an export named 'startParamsFor'
```

## GREEN commands and results
- `npx tsx --test test/tools.test.ts test/launch-options.test.ts test/job-manager.test.ts`
  - PASS: 101 tests, 0 failures.
- `npm run typecheck`
  - PASS: `tsc --noEmit`, exit 0.
- `git diff --check`
  - PASS: no whitespace errors.

The requested `lsp_diagnostics` and `lens_diagnostics` tools were unavailable in this harness.

## Commit
- `23e75f1d8b947d96994e42c5d53e3c9c6c9de795` — `feat: gate job thinking behind start policy`

## Self-review
- The disabled schema rejects `thinkingLevel` and both schema variants reject unknown task properties.
- Direct `startJobs` calls default to disabled behavior.
- Enabled direct calls preserve existing job-thinking launch behavior.
- Request conversion no longer emits an undefined `thinkingLevel` field when disabled.
- No unrelated files or abstractions were added.

## Concerns
- Runtime wiring of `SimpleSubagentsConfig.allowThinkingOverrides` into tool registration is outside this task and remains for the follow-up integration task.
- Editor diagnostics could not be run because those tools were unavailable.

## Fix Round 1

### Changed lines
- `test/tools.test.ts:185-206`
  - Added a registered enabled-policy start test.
  - It executes the registered `subagent_start` tool with a job model and thinking override, then asserts `Launch model: ollama/llama3.1:8b` and `Launch thinking: low (job override)`.

### Test command and exact result
```bash
npx tsx --test test/tools.test.ts
```
Result: `42` tests passed, `0` failed; exit code `0`.

### Commit
- `368360f5d2ff47761a7716980d6f5353372b22c6` — `test: restore enabled launch rendering coverage`

### Self-review
- The test uses the real registered enabled policy (`registerSubagentTools(..., true)`) and the registered tool execution path.
- It checks both required renderer values.
- No production files or unrelated tests were changed.
