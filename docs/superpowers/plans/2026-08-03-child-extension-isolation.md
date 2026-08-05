# Child Extension Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every subagent child process disable Pi extension discovery so completed agents close normally without child extension side effects.

**Architecture:** Add `--no-extensions` to the unconditional argument prefix in `PiProcessRunner.run`; keep process-close settlement and every other launch option unchanged. Lock the boundary with argument-contract tests, document the child runtime, and use an opt-in real-Pi assertion plus a disposable edit probe for integration confidence.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, `node:test`, Pi 0.82.x CLI JSON print mode

## Global Constraints

- Every child Pi launch must include exactly one `--no-extensions`.
- No parent request, profile field, or configuration may remove child extension isolation.
- Do not add an explicit `--extension` or `-e` child argument.
- Keep skills, prompt templates, project instructions, model selection, thinking selection, tool permissions, cancellation, capture, and process-close settlement unchanged.
- `turn_end` remains activity only; do not settle jobs on `turn_end` or `agent_end`.
- Do not add execution deadlines, extension allowlists, or profile escape hatches.
- Keep the change dependency-free and compatible with Node.js 22.19+ and Pi 0.82.x.

---

## File Structure

- Modify `src/process-runner.ts`: define the fixed child Pi argument prefix by adding mandatory extension isolation.
- Modify `test/process-runner.test.ts`: lock exact isolation placement, uniqueness, and absence of explicit extension paths across the existing launch contract.
- Modify `test/integration.test.ts`: assert that a real Pi child invocation receives the isolation flag in the existing opt-in integration path.
- Modify `README.md`: explain the isolated child runtime and the parent-prepares-sources research workflow.

No new source module, configuration field, or public type is needed.

---

### Task 1: Isolate Every Child Pi Process

**Files:**

- Modify: `src/process-runner.ts:182-185`
- Test: `test/process-runner.test.ts:73-108, 165-198`
- Test: `test/integration.test.ts:12-65`
- Modify: `README.md:82`

**Interfaces:**

- Consumes: `PiProcessRunner.run(options: ProcessRunOptions): RunningProcess` and its existing fixed `args` prefix.
- Produces: every spawned child invocation contains exactly one `--no-extensions`; no exported TypeScript signature changes.

- [ ] **Step 1: Write the failing unit launch-contract assertions**

In `test/process-runner.test.ts`, add this helper immediately after `argumentValue`:

```ts
const assertIsolatedInvocation = (args: readonly string[]): void => {
  assert.equal(
    args.filter((argument) => argument === "--no-extensions").length,
    1,
  );
  assert.equal(args.includes("--extension"), false);
  assert.equal(args.includes("-e"), false);
};
```

Change the first launch test’s fixed-prefix assertion from five entries to six, then call the helper:

```ts
assert.deepEqual(actual.args.slice(0, 6), [
  process.argv[1],
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--no-extensions",
]);
assertIsolatedInvocation(actual.args);
```

Rename `keeps legacy process arguments byte-for-byte unchanged` to `passes legacy launch options with child extension isolation`. Insert `"--no-extensions"` immediately after `"--no-session"` in its exact expected argument list, then call the helper:

```ts
assert.deepEqual(invocation().args, [
  process.argv[1],
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--no-extensions",
  "--model",
  "ollama/llama3.1:8b:high",
  "--no-tools",
  "Inspect the repository",
]);
assertIsolatedInvocation(invocation().args);
```

Also call `assertIsolatedInvocation(invocation().args)` in these existing tests after their current model, thinking, or tool assertions and before `child.close()`:

- `passes opaque override model and explicit thinking as separate arguments`
- `passes thinking without model when child Pi must select its default`
- `intersects named read-only profile tools with the read-only permission set`
- `permits requested write tools for writable named profiles`

The fixed-prefix assertion proves placement. The helper calls prove that generic, legacy, model, thinking, named read-only, and named writable paths contain exactly one isolation flag and no explicit extension path.

- [ ] **Step 2: Run the focused tests and verify the new contract fails**

Run:

```bash
npx tsx --test test/process-runner.test.ts
```

Expected: FAIL in the first launch test, renamed legacy launch test, and helper-covered launch paths because child arguments do not yet contain `--no-extensions`.

- [ ] **Step 3: Add the minimal fixed child argument**

In `PiProcessRunner.run`, change the initial argument array to:

```ts
const args = [
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--no-extensions",
];
```

Do not add conditionals, configuration, profile checks, explicit extension paths, `agent_end` settlement, or new timers.

- [ ] **Step 4: Run the process-runner tests and verify they pass**

Run:

```bash
npx tsx --test test/process-runner.test.ts
```

Expected: all process-runner tests PASS, including model, thinking, tool permission, prompt-file, event capture, close, error, and cancellation cases.

- [ ] **Step 5: Add the opt-in real-Pi invocation assertion**

In the existing `real Pi reads a file with the generic read-only profile` integration test, immediately after `assert.equal(invocation.command, "pi");`, add:

```ts
assert.equal(
  invocation.args.filter((argument) => argument === "--no-extensions").length,
  1,
);
assert.equal(invocation.args.includes("--extension"), false);
assert.equal(invocation.args.includes("-e"), false);
```

This assertion uses the real runner spawn boundary while preserving the existing opt-in test and cleanup behavior.

- [ ] **Step 6: Update the child capability documentation**

In `README.md`, replace:

```md
These are launch ceilings, not guarantees of effective runtime tools: trusted child extensions may alter active tools.
```

with:

```md
Children run with Pi extension discovery disabled. Profile tool lists therefore select built-in tools only; extension-provided web, MCP, diagnostic, nested-subagent, UI, and lifecycle behavior is unavailable. For research that needs external sources, have the parent fetch or clone them before starting a child that analyzes the local copies.
```

Keep the surrounding discovery privacy and writable authorization text unchanged.

- [ ] **Step 7: Run the complete automated verification**

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run
git diff --check
```

Expected:

- `npm test`: 220 or more tests pass, with only the two opt-in real-Pi integration tests skipped when `SIMPLE_SUBAGENTS_INTEGRATION` is unset.
- `npm run typecheck`: exits zero with no TypeScript errors.
- `npm pack --dry-run`: lists only the intended package files and exits zero.
- `git diff --check`: exits zero with no whitespace errors.

- [ ] **Step 8: Run the opt-in real-Pi integration assertion**

Run:

```bash
SIMPLE_SUBAGENTS_INTEGRATION=1 \
  npx tsx --test \
  --test-name-pattern='real Pi reads a file with the generic read-only profile' \
  test/integration.test.ts
```

Expected: the selected integration test PASSes, confirms the real invocation contains mandatory isolation, reads the temporary file, and closes normally. The unrelated thinking-precedence integration test may report skipped because its separate model-pattern environment variable is unset.

- [ ] **Step 9: Repeat the disposable edit-task completion probe**

Run from a disposable directory, using an authenticated inexpensive model available in Pi:

```bash
probe_dir="$(mktemp -d)"
(
  cd "$probe_dir"
  pi --mode json -p --no-session --no-extensions \
    --model openai-codex/gpt-5.6-luna \
    --thinking minimal \
    --tools write \
    'Use the write tool to create probe.ts containing exactly: export const value = 1; Then reply exactly: done'
)
probe_status=$?
test -f "$probe_dir/probe.ts"
rm -rf "$probe_dir"
test "$probe_status" -eq 0
```

Expected: Pi emits `agent_end`, exits without manual termination, creates `probe.ts`, and the shell returns zero. If the named model is unavailable, substitute another authenticated low-cost model and record the exact model used; do not weaken or remove `--no-extensions`.

- [ ] **Step 10: Inspect the final focused diff**

Run:

```bash
git status --short
git diff -- src/process-runner.ts test/process-runner.test.ts test/integration.test.ts README.md
```

Expected: only the four planned files are modified; the source change is one fixed argument, tests lock that argument, and README describes isolation. Restore any unrelated formatter rewrites before committing.

- [ ] **Step 11: Commit the focused fix**

```bash
git add src/process-runner.ts test/process-runner.test.ts test/integration.test.ts README.md
git commit -m "fix: isolate child Pi extensions"
```

- [ ] **Step 12: Verify the committed tree**

Run:

```bash
git status --short --branch
git show --stat --oneline HEAD
```

Expected: the working tree is clean and the commit contains only `src/process-runner.ts`, `test/process-runner.test.ts`, `test/integration.test.ts`, and `README.md`.
