# Simple Subagents Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every remaining review item without changing the extension's architecture or adding framework-like abstractions.

**Architecture:** Keep the existing runner, manager, tools, and dashboard boundaries. Add missing byte-count metadata directly to existing result/job/progress records, make dashboard delivery retryable by ordering two synchronous operations safely, distinguish three write-confirmation outcomes with a string union, add a finite cancellation race matrix, and align package metadata with the installed Pi runtime.

**Tech Stack:** TypeScript, Node.js built-ins, Pi extension/TUI APIs 0.82.1, TypeBox, Node's test runner through `tsx`.

## Global Constraints

- Keep the extension memory-only and session-scoped.
- Keep captured final output, stderr, error text, and latest partial output UTF-8-safe and bounded at `50 * 1024` bytes each.
- Keep the complete model-visible collected payload, including metadata and notices, at or below `50 * 1024` bytes.
- Preserve shell-free subprocess execution, read-only defaults, the four-job concurrency limit, and the eight-job batch limit.
- Add no runtime dependencies and no buffer, transaction, scheduler, result, controller, or compatibility framework.
- Use direct functions, string unions, optional record fields, and existing dependency seams.
- Normal `npm test` must skip the real-Pi test; credentialed verification remains opt-in.
- Publish and test with Node.js `>=22.19.0`, matching the installed Pi 0.82.1 packages.

---

## File Structure

- `src/types.ts` — add optional truncation metadata to progress and job diagnostics.
- `src/process-runner.ts` — retain cumulative original byte counts for partial/error capture.
- `src/job-manager.ts` — preserve and defensively normalize new metadata.
- `src/output.ts` — place producer-capture notices before truncatable bodies.
- `src/dashboard.ts` — show partial/error metadata and make result delivery retryable.
- `src/tools.ts` and `src/index.ts` — distinguish approved, declined, and unavailable write confirmation.
- `test/*.test.ts` — focused regressions using existing fakes.
- `test/package.test.ts` — package/runtime version-floor check.
- `package.json`, `package-lock.json`, and `README.md` — align the Node floor and document it.

---

### Task 1: Complete capture metadata and make truncation notices durable

**Files:**

- Modify: `src/types.ts`
- Modify: `src/process-runner.ts`
- Modify: `src/job-manager.ts`
- Modify: `src/output.ts`
- Modify: `src/dashboard.ts`
- Modify: `test/process-runner.test.ts`
- Modify: `test/job-manager.test.ts`
- Modify: `test/json-output.test.ts`
- Modify: `test/dashboard.test.ts`
- Modify: `test/tools.test.ts`

**Interfaces:**

- Extends `ProgressItem` with optional `truncation?: TextTruncation`.
- Extends `ProcessResult` and `Job` with optional `errorTruncation?: TextTruncation`.
- Keeps `outputTruncation`, `stderrTruncation`, and all existing fields backward-compatible.
- `formatCollectedResult(job)` continues returning one string capped by `COLLECTED_OUTPUT_MAX_BYTES`.

- [ ] **Step 1: Write failing cumulative partial/error metadata tests**

Add runner tests that send multiple multibyte `text_delta` events whose combined source exceeds `CAPTURED_TEXT_MAX_BYTES`, and an oversized assistant `errorMessage`. Assert the retained strings are byte-safe and capped, while metadata counts the complete original source:

```typescript
assert.ok(Buffer.byteLength(latest.text, "utf8") <= CAPTURED_TEXT_MAX_BYTES);
assert.deepEqual(latest.truncation, {
  originalBytes: Buffer.byteLength(firstDelta + secondDelta, "utf8"),
  keptBytes: Buffer.byteLength(latest.text, "utf8"),
});
assert.deepEqual(result.errorTruncation, {
  originalBytes: Buffer.byteLength(errorText, "utf8"),
  keptBytes: Buffer.byteLength(result.errorMessage ?? "", "utf8"),
});
```

Add a manager test proving upstream metadata survives defensive normalization and the latest text item retains its own metadata.

- [ ] **Step 2: Write failing formatter and dashboard notice tests**

Create completed and failed jobs with large tasks/bodies plus output, stderr, error, and partial truncation metadata. Assert:

```typescript
assert.ok(Buffer.byteLength(formatted, "utf8") <= COLLECTED_OUTPUT_MAX_BYTES);
assert.match(formatted, /Output capture truncated: retained 51200 of 70000 bytes/);
assert.match(formatted, /Error capture truncated: retained 51200 of 80000 bytes/);
assert.match(formatted, /Partial output capture truncated: retained 51200 of 90000 bytes/);
```

The completed case must retain its output-capture notice. The failed/cancelled case must include the latest partial text and its notice. Add dashboard detail assertions for `Error capture` and `Partial output capture`.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts test/json-output.test.ts test/dashboard.test.ts test/tools.test.ts \
  --test-name-pattern="partial.*metadata|error.*metadata|capture notice"
```

Expected: FAIL because progress/error metadata is absent and producer notices can be truncated away.

- [ ] **Step 4: Add the optional metadata fields**

Use the existing `TextTruncation` type:

```typescript
export interface ProgressItem {
  type: "text" | "tool" | "diagnostic";
  text: string;
  timestamp: number;
  truncation?: TextTruncation;
}

export interface Job {
  // existing fields
  errorTruncation?: TextTruncation;
}
```

Add `errorTruncation?: TextTruncation` to `ProcessResult` as well. Do not create a generalized diagnostics object.

- [ ] **Step 5: Track cumulative source bytes in the runner**

Keep a source-byte counter for the current assistant partial message. Reset it on assistant `message_start` and `message_end`. Each delta increments the counter even after retained text reaches the cap:

```typescript
partialOriginalBytes += Buffer.byteLength(delta, "utf8");
partialOutput = truncateUtf8(partialOutput + delta, CAPTURED_TEXT_MAX_BYTES).text;
const keptBytes = Buffer.byteLength(partialOutput, "utf8");
options.onProgress({
  type: "text",
  text: partialOutput,
  timestamp: Date.now(),
  truncation: partialOriginalBytes > keptBytes
    ? { originalBytes: partialOriginalBytes, keptBytes }
    : undefined,
});
```

When capturing assistant or spawn errors, retain both the truncated text and `truncateUtf8(...).truncation`. Clear stale error metadata when replacing the error with a later untruncated value.

- [ ] **Step 6: Preserve metadata in `JobManager`**

When defensively capping error text or text progress, combine existing upstream metadata with the local retained byte count:

```typescript
const captured = truncateUtf8(item.text, CAPTURED_TEXT_MAX_BYTES);
const originalBytes = item.truncation?.originalBytes ?? Buffer.byteLength(item.text, "utf8");
const keptBytes = Buffer.byteLength(captured.text, "utf8");
const truncation = originalBytes > keptBytes ? { originalBytes, keptBytes } : undefined;
```

Apply the same rule to `result.errorMessage`/`result.errorTruncation`. Continue retaining one latest text item plus the existing bounded non-text history.

- [ ] **Step 7: Put capture notices before truncatable content**

In `formatCollectedResult()`, find the latest text progress item and build an early `## Capture limits` section before task/output bodies:

```typescript
const latestPartial = [...job.progress].reverse().find((item) => item.type === "text");
const captureNotices = [
  captureNotice("Output", job.outputTruncation ?? job.truncation),
  captureNotice("Stderr", job.stderrTruncation),
  captureNotice("Error", job.errorTruncation),
  captureNotice("Partial output", latestPartial?.truncation),
].filter((notice): notice is string => notice !== undefined);
```

Place that section immediately after the result heading, before unbounded task/body text. For failed/cancelled jobs, include `Partial output:` with the latest retained text or `none`. Keep the existing final-cap notice reservation in `truncateFormattedResult()`.

- [ ] **Step 8: Render the same metadata in dashboard details**

Add explicit detail lines for error and latest-partial capture metadata, using `not truncated` when absent. Reuse existing wrapping/truncation; do not add a diagnostics renderer class.

- [ ] **Step 9: Run focused and regression tests**

Run:

```bash
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts test/json-output.test.ts test/dashboard.test.ts test/tools.test.ts
npm run typecheck
npm run test:unit
```

Expected: PASS with producer notices visible and all payloads within their byte caps.

- [ ] **Step 10: Commit capture metadata hardening**

```bash
git add src/types.ts src/process-runner.ts src/job-manager.ts src/output.ts src/dashboard.ts \
  test/process-runner.test.ts test/job-manager.test.ts test/json-output.test.ts test/dashboard.test.ts test/tools.test.ts
git commit -m "fix: preserve subagent truncation diagnostics"
```

---

### Task 2: Make dashboard delivery retryable and remove redundant renders

**Files:**

- Modify: `src/dashboard.ts`
- Modify: `test/dashboard.test.ts`

**Interfaces:**

- Keeps `SubagentsDashboard` and `registerSubagentsUi()` signatures unchanged.
- Keeps `simple-subagents-result` and `{ deliverAs: "nextTurn" }` unchanged.

- [ ] **Step 1: Write failing delivery-order and render-count tests**

Add a test whose `pi.sendMessage()` throws. Select a completed job, press `x`, and assert the job remains `completed`, no collection is recorded, and the user receives an error notification. Then retry with a successful sender and assert the job becomes `collected` exactly once.

Add request-render counts for queued cancellation, collection, and discard. Each synchronous manager notification must cause one render request rather than one subscription render plus one unconditional input render.

- [ ] **Step 2: Run dashboard tests and verify RED**

Run:

```bash
npx tsx --test test/dashboard.test.ts --test-name-pattern="retry|one render"
```

Expected: FAIL because collection currently occurs before message injection and action handling calls `changed()` again.

- [ ] **Step 3: Send before collecting**

Use the existing synchronous Pi API directly:

```typescript
const formatted = formatCollectedResult(selected);
this.options.pi.sendMessage(message, { deliverAs: "nextTurn" });
this.options.manager.collect(selected.id);
```

If `sendMessage()` throws, the existing catch calls `actionFailed("collect")` while the inbox state is unchanged and retryable. Do not add rollback, transaction, or message-delivery state.

- [ ] **Step 4: Let manager subscriptions own action rendering**

Call `changed()` only for navigation and detail toggles. After cancel/collect/discard dispatch, return from `handleInput()` and rely on manager notification; retain `actionFailed()` for failure refreshes.

Keep one local boolean or direct early returns—do not add an action dispatcher.

- [ ] **Step 5: Confirm the shutdown test name is already accurate**

Keep or rename the test to exactly:

```typescript
test("extension clears the widget before manager shutdown", async () => { /* existing body */ });
```

This item requires no production change if the current title already matches.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
npx tsx --test test/dashboard.test.ts
npm run typecheck
npm run test:unit
```

Then commit:

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "fix: keep dashboard collection retryable"
```

---

### Task 3: Distinguish writable confirmation outcomes

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/index.ts`
- Modify: `test/tools.test.ts`

**Interfaces:**

- Adds `export type WriteConfirmation = "approved" | "declined" | "unavailable"`.
- Changes `ToolServices.confirmWritable(...)` to return `Promise<WriteConfirmation>`.
- Leaves tool schemas and `subagent_start` parameters unchanged.

- [ ] **Step 1: Write failing service and runtime tests**

Cover all three outcomes:

```typescript
assert.equal(declined.content[0]?.text, "Writable jobs were declined.");
assert.deepEqual(declined.details.diagnostics, ["Writable jobs were declined."]);

assert.equal(unavailable.content[0]?.text, "Writable confirmation requires interactive UI.");
assert.deepEqual(unavailable.details.diagnostics, ["Writable confirmation requires interactive UI."]);
```

Assert neither case enqueues jobs. Assert disabled confirmation returns `approved`, while UI confirmation maps `true` to `approved` and `false` to `declined`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx tsx --test test/tools.test.ts --test-name-pattern="writable.*declined|writable.*interactive"
```

Expected: FAIL because both outcomes currently collapse to `false` and an empty diagnostic list.

- [ ] **Step 3: Implement the string union directly**

In `src/tools.ts`:

```typescript
export type WriteConfirmation = "approved" | "declined" | "unavailable";

export interface ToolServices {
  manager: JobManager;
  getProfiles(): Promise<ReadonlyMap<string, AgentProfile>>;
  confirmWritable(requests: readonly JobRequest[], ctx: ExtensionContext): Promise<WriteConfirmation>;
  defaults(ctx: ExtensionContext): { cwd: string; parentModel?: string; thinkingLevel?: string };
}
```

In `startJobs()`, return a successful diagnostic response for `declined` or `unavailable`; enqueue only `approved`.

In `src/index.ts`, map configuration/UI state directly:

```typescript
if (!config.confirmWrites || requests.length === 0) return "approved";
if (!ctx.hasUI) return "unavailable";
return (await ctx.ui.confirm(title, message)) ? "approved" : "declined";
```

Do not introduce error classes or a confirmation service object.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
npm run test:unit
```

Then commit:

```bash
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "fix: report writable confirmation outcomes"
```

---

### Task 4: Close the finite cancellation race coverage gap

**Files:**

- Modify: `test/job-manager.test.ts`
- Modify: `src/job-manager.ts` only if a new regression exposes a real bug

**Interfaces:**

- No public API changes.
- Uses the existing `ControlledRunner`, `releaseCancel()`, `rejectCancel()`, `complete()`, `fail()`, and `flush()` helpers.

- [ ] **Step 1: Add three focused race tests**

Add exactly these cases:

1. Cancellation signaling resolves before `process.result`; the job is `cancelled`, but its active slot remains occupied and queued work does not start until result settlement.
2. `process.result` rejects while cancellation signaling is pending; explicit cancellation remains terminal and concurrent callers receive the same cancelled state.
3. `cancel(id)` and `shutdown()` overlap; the runner receives one cancellation call, both operations wait for the same process settlement, and no queued work starts.

Use assertions of this shape:

```typescript
const cancel = manager.cancel("job-1");
fake.releaseCancel(0);
await cancel;
assert.equal(manager.get("job-1")?.state, "cancelled");
assert.equal(fake.started.length, 1);
fake.complete(0, failedResult());
await fake.flush();
assert.equal(fake.started.length, 2);
```

- [ ] **Step 2: Run the new tests**

Run:

```bash
npx tsx --test test/job-manager.test.ts --test-name-pattern="signal resolves before result|result rejects during cancellation|cancel and shutdown overlap"
```

Expected: PASS if existing coordination is complete; otherwise RED identifies one concrete manager bug.

- [ ] **Step 3: Make only a test-proven manager fix if needed**

If a regression fails, adjust the existing `cancellation`, `active`, or shutdown promise ordering directly. Do not add states, locks, queues, cancellation tokens, or a generic deferred abstraction.

- [ ] **Step 4: Run manager regressions and commit**

Run:

```bash
npx tsx --test test/job-manager.test.ts
npm run typecheck
npm run test:unit
```

Then commit the test-only change, or the minimal tested fix plus tests:

```bash
git add test/job-manager.test.ts src/job-manager.ts
git commit -m "test: cover job cancellation race ordering"
```

---

### Task 5: Align runtime metadata and perform the final merge gate

**Files:**

- Create: `test/package.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**

- Published Node engine floor becomes `>=22.19.0`.
- Runtime dependencies and Pi extension entry point remain unchanged.
- `test:unit` includes `test/package.test.ts`; the opt-in integration test remains excluded.

- [ ] **Step 1: Write the failing package-floor test**

Read the root package and the four installed Pi package manifests. Assert the extension does not advertise a lower Node floor than its tested Pi peers:

```typescript
const piPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

assert.equal(root.engines?.node, ">=22.19.0");
for (const name of piPackages) {
  const manifest = JSON.parse(await readFile(join("node_modules", name, "package.json"), "utf8"));
  assert.equal(manifest.engines?.node, ">=22.19.0");
}
```

- [ ] **Step 2: Run the package test and verify RED**

Run:

```bash
npx tsx --test test/package.test.ts
```

Expected: FAIL because the root package currently advertises `>=20`.

- [ ] **Step 3: Align metadata and documentation**

Set:

```json
"engines": { "node": ">=22.19.0" }
```

Add `test/package.test.ts` to the explicit `test:unit` script. Run `npm install --package-lock-only` so the lockfile root metadata matches. Add a concise README requirement line:

```markdown
Requires Node.js 22.19 or newer and Pi 0.82.x.
```

Do not pin peer dependencies or add a compatibility layer.

- [ ] **Step 4: Run the package checks**

Run:

```bash
npx tsx --test test/package.test.ts
npm run typecheck
npm run test:unit
npm test
npm pack --dry-run
```

Expected: package test passes, unit/full suites pass with one normal integration skip, and the tarball still contains only `package.json`, `README.md`, and `src/**`.

- [ ] **Step 5: Run the credentialed smoke and proactive diagnostics**

Run:

```bash
SIMPLE_SUBAGENTS_INTEGRATION=1 npx tsx --test --test-name-pattern="real Pi" test/integration.test.ts
git diff --check
git status --short
```

Then run `lsp_diagnostics` over `src/` and `test/`, followed by `lens_diagnostics mode=all`. Resolve blocking diagnostics only with focused changes and rerun their tests.

- [ ] **Step 6: Commit compatibility metadata**

```bash
git add package.json package-lock.json README.md test/package.test.ts
git commit -m "fix: align package Node requirement"
```

- [ ] **Step 7: Run the final whole-branch review**

Generate one review package from the merge base through `HEAD`. Give the reviewer this plan, the original design, test/pack/diagnostic evidence, and the prior parked/deferred ledger entries. Require zero open Critical or Important findings before merge readiness.

Expected: the previous truncation-metadata, dashboard-delivery, confirmation-diagnostic, cancellation-coverage, test-title, redundant-render, and Node-floor items are all resolved without new architecture.

---

## Plan Self-Review

- Every real remaining review item has an implementation or finite verification step.
- The stale shutdown-title item is handled by asserting the already-correct narrow title rather than manufacturing a code change.
- The plan adds one string union and optional metadata fields; it introduces no new subsystem.
- Dashboard retryability uses send-before-collect ordering instead of rollback or transactions.
- Cancellation coverage is capped at three named races to prevent an open-ended test matrix.
- Node compatibility is resolved by matching the tested Pi floor, not by creating Node 20 support work.
- The real-process integration test remains opt-in and outside `test:unit`.
