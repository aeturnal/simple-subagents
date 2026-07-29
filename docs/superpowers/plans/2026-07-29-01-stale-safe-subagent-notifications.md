# Stale-Safe Subagent Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one stale-safe completion hint per terminal job transition while omitting results that are no longer collectable when the debounce flush runs.

**Architecture:** Keep notification bookkeeping inside `installCompletionNotifier()` and preserve its existing `previous`, `pending`, and `notified` structures. At flush time, re-read pending IDs through `JobManager.get()`, send only current `completed`, `failed`, or `cancelled` jobs, contain delivery failures, and use action-neutral copy that remains correct after queueing.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi extension/TUI APIs, Node's test runner through `tsx`.

## Global Constraints

- Do not collect results automatically or call `manager.collect()` from notification code.
- Do not add a `completionPolicy` setting.
- Do not add notification state to `JobState`, `Job`, `JobManager`, or persisted session entries.
- Do not change collection, discard, cancellation, job, or tool APIs.
- Keep notification timers and state session-scoped.
- Continue using `{ deliverAs: "followUp", triggerTurn: true }`.
- Treat only `completed`, `failed`, and `cancelled` jobs as collectable.
- Catch `pi.sendMessage()` failures at the notifier boundary, preserve inbox results, and do not retry.
- Do not render job output in `simple-subagents-ready` messages.
- On shutdown, unsubscribe, clear the outstanding debounce timer, clear pending candidates, and make a racing flush a no-op.
- Keep the implementation direct and dependency-free.

---

## File Structure

- `src/index.ts` — retain the notifier and renderer, adding flush-time filtering, stale-safe copy, delivery containment, and shutdown-race protection.
- `test/tools.test.ts` — extend the existing notifier tests and fakes with focused stale filtering, rendering, delivery failure, and lifecycle regressions.
- `README.md` — document completion notices as availability hints and collection as an explicit parent action.

---

### Task 1: Filter stale jobs and send action-neutral availability hints

**Files:**
- Modify: `test/tools.test.ts:405-466`
- Modify: `src/index.ts:26-68`

**Interfaces:**
- Consumes: `JobManager.get(id: string): Job | undefined`, `Job.state`, and the existing `TimerDependencies` seam.
- Produces: unchanged `installCompletionNotifier(pi: ExtensionAPI, manager: JobManager, timers?: TimerDependencies): () => void`.
- Produces: `simple-subagents-ready` messages with `details: { jobIds: string[] }` containing only flush-time-collectable IDs.
- Preserves: `{ deliverAs: "followUp", triggerTurn: true }`; notification code does not call `collect()` or `discard()`.

- [ ] **Step 1: Strengthen the existing terminal-transition test with exact stale-safe copy**

In `test/tools.test.ts`, keep the existing test named `completion notices debounce real terminal transitions at 100 ms, including cancellation, without leaking output`, and replace its content assertions with:

```typescript
  assert.equal(
    pi.messages[0]?.content,
    "Jobs may be ready: job-1 (completed), job-2 (failed), job-3 (cancelled).\n" +
      "Check their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.",
  );
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /secret/);
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /ask the user/i);
  assert.deepEqual(pi.messageOptions[0], { deliverAs: "followUp", triggerTurn: true });
```

This retains the existing assertions for the 100 ms delay, grouped IDs, failed/cancelled jobs, and no duplicate notice after the cancelled process later resolves.

- [ ] **Step 2: Add failing collection, discard, and mixed-batch tests**

Add these tests immediately after the existing terminal-transition test:

```typescript
test("completion notifier suppresses jobs collected or discarded before flush", async () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  manager.enqueue(
    [
      { task: "collect", agent: "generic", writeAccess: false },
      { task: "discard", agent: "generic", writeAccess: false },
    ],
    new Map([["generic", { ...profile, name: "generic", source: "builtin" }]]),
    { cwd: "/workspace" },
  );

  runner.started[0]?.resolve(completed("collected output"));
  runner.started[1]?.resolve(completed("discarded output"));
  await runner.flush();
  manager.collect("job-1");
  manager.discard("job-2");
  timers.runAll();

  assert.equal(pi.messages.length, 0);
  assert.equal(manager.get("job-1")?.state, "collected");
  assert.equal(manager.get("job-2")?.state, "discarded");
  cleanup();
});

test("completion notifier keeps only collectable jobs in a mixed flush", async () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  manager.enqueue(
    [
      { task: "collect", agent: "generic", writeAccess: false },
      { task: "discard", agent: "generic", writeAccess: false },
      { task: "retain", agent: "generic", writeAccess: false },
    ],
    new Map([["generic", { ...profile, name: "generic", source: "builtin" }]]),
    { cwd: "/workspace" },
  );

  runner.started[0]?.resolve(completed());
  runner.started[1]?.resolve({ ...completed(), exitCode: 1 });
  await manager.cancel("job-3");
  await runner.flush();
  manager.collect("job-1");
  manager.discard("job-2");
  timers.runAll();

  assert.deepEqual(pi.messages[0]?.details, { jobIds: ["job-3"] });
  assert.equal(
    pi.messages[0]?.content,
    "Jobs may be ready: job-3 (cancelled).\n" +
      "Check their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.",
  );
  cleanup();
});
```

- [ ] **Step 3: Add failing missing-job and post-queue staleness tests**

Add:

```typescript
test("completion notifier treats a missing candidate as stale without suppressing another job", () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  let listener: ((jobs: readonly Job[]) => void) | undefined;
  const current = new Map<string, Job>([["job-2", { id: "job-2", state: "failed" } as Job]]);
  const manager = {
    subscribe(next: (jobs: readonly Job[]) => void) {
      listener = next;
      next([
        { id: "job-1", state: "running" } as Job,
        { id: "job-2", state: "running" } as Job,
      ]);
      return () => { listener = undefined; };
    },
    get(id: string) { return current.get(id); },
  } as unknown as JobManager;
  const cleanup = installCompletionNotifier(pi as never, manager, timers);

  listener?.([
    { id: "job-1", state: "completed" } as Job,
    { id: "job-2", state: "failed" } as Job,
  ]);
  timers.runAll();

  assert.deepEqual(pi.messages[0]?.details, { jobIds: ["job-2"] });
  assert.match(pi.messages[0]?.content ?? "", /job-2 \(failed\)/);
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /job-1/);
  cleanup();
});

test("queued completion copy remains safe when collection happens before processing", async () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  manager.enqueue(
    [{ task: "answer", agent: "generic", writeAccess: false }],
    new Map([["generic", { ...profile, name: "generic", source: "builtin" }]]),
    { cwd: "/workspace" },
  );

  runner.started[0]?.resolve(completed());
  await runner.flush();
  timers.runAll();
  manager.collect("job-1");

  assert.equal(manager.get("job-1")?.state, "collected");
  assert.match(pi.messages[0]?.content ?? "", /Check their current state/);
  assert.match(pi.messages[0]?.content ?? "", /otherwise no action is required/);
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /ask the user/i);
  assert.equal(timers.pending.length, 0);
  cleanup();
});
```

- [ ] **Step 4: Add a failing renderer regression for filtered IDs and compact/expanded output**

Add:

```typescript
test("ready-message renderer shows stale-safe copy and expands only filtered IDs", () => {
  const pi = new FakePi();
  createSimpleSubagentsExtension()(pi as never);
  const renderer = pi.messageRenderers.get("simple-subagents-ready") as (
    message: unknown,
    options: { expanded: boolean; outputPad: number },
    theme: { fg(color: string, value: string): string },
  ) => { render(width: number): string[] };
  const message = {
    customType: "simple-subagents-ready",
    content: "Jobs may be ready: job-2 (failed).\nCheck their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.",
    display: true,
    details: { jobIds: ["job-2"] },
  };
  const theme = { fg: (_color: string, value: string) => value };

  const compact = renderer(message, { expanded: false, outputPad: 0 }, theme).render(200).join("\n");
  const expanded = renderer(message, { expanded: true, outputPad: 0 }, theme).render(200).join("\n");
  const fallback = renderer(
    { customType: "simple-subagents-ready", details: { jobIds: [] } },
    { expanded: false, outputPad: 0 },
    theme,
  ).render(200).join("\n");

  assert.match(compact, /Jobs may be ready/);
  assert.match(compact, /otherwise no action is required/);
  assert.equal(compact.match(/job-2/g)?.length, 1);
  assert.equal(expanded.match(/job-2/g)?.length, 2);
  assert.doesNotMatch(expanded, /job-1|job output/);
  assert.equal(fallback, "Jobs may be ready.");
});
```

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='completion notifier|completion notices|queued completion|ready-message renderer' test/tools.test.ts
```

Expected: FAIL because the flush trusts the transition-time state, includes handled/missing jobs, and still says `Ready jobs` plus `Ask the user`.

- [ ] **Step 6: Re-read candidates at flush and build the exact stale-safe message**

In `src/index.ts`, replace the current `flush` function with:

```typescript
  const flush = () => {
    timer = undefined;
    const candidates = [...pending.keys()];
    pending.clear();
    const ready = candidates.flatMap((id) => {
      const job = manager.get(id);
      return job && terminal.has(job.state) ? [[job.id, job.state] as const] : [];
    });
    if (ready.length === 0) return;
    const jobIds = ready.map(([id]) => id);
    const summary = `Jobs may be ready: ${ready.map(([id, state]) => `${id} (${state})`).join(", ")}.`;
    pi.sendMessage({
      customType: "simple-subagents-ready",
      content: `${summary}\nCheck their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.`,
      display: true,
      details: { jobIds },
    }, { deliverAs: "followUp", triggerTurn: true });
  };
```

Do not remove IDs from `notified`: each terminal transition remains eligible for at most one scheduled notice, even when it is filtered out later.

- [ ] **Step 7: Make the renderer fallback stale-safe**

In the existing `simple-subagents-ready` renderer, replace only the fallback string:

```typescript
      const content = typeof message.content === "string" ? message.content : "Jobs may be ready.";
```

The existing renderer already keeps output absent, uses `details.jobIds`, and appends those IDs only when expanded.

- [ ] **Step 8: Run focused tests, the notifier's containing test file, and typecheck**

Run:

```bash
npx tsx --test --test-name-pattern='completion notifier|completion notices|queued completion|ready-message renderer' test/tools.test.ts
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: PASS. The mixed message contains only `job-3`; fully stale batches produce no message; failed and cancelled states still notify; later unrelated updates do not duplicate a notice.

- [ ] **Step 9: Commit flush-time filtering and copy**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "fix: filter stale subagent completion notices"
```

---

### Task 2: Contain message-delivery failures without consuming results or retrying

**Files:**
- Modify: `test/tools.test.ts:606-631`
- Modify: `src/index.ts:40-55`

**Interfaces:**
- Consumes: synchronous `pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true })`.
- Produces: no new public interface; `installCompletionNotifier()` contains thrown delivery errors.
- Preserves: a failed delivery leaves the job in its current collectable state and leaves its ID in `notified`, so unrelated manager updates cannot retry it.

- [ ] **Step 1: Make `FakePi` able to throw and count delivery attempts**

Add these fields beside `FakePi.messageOptions`:

```typescript
  sendError: Error | undefined;
  sendAttempts = 0;
```

Replace `FakePi.sendMessage()` with:

```typescript
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options: unknown): void {
    this.sendAttempts += 1;
    if (this.sendError) throw this.sendError;
    this.messages.push(message);
    this.messageOptions.push(options);
  }
```

- [ ] **Step 2: Add the failing delivery-failure test**

Add after the stale-filter tests:

```typescript
test("completion notifier contains delivery failure, preserves the inbox result, and does not retry", async () => {
  const pi = new FakePi();
  pi.sendError = new Error("delivery unavailable");
  const timers = new FakeTimers();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  manager.enqueue(
    [{ task: "preserve", agent: "generic", writeAccess: false }],
    new Map([["generic", { ...profile, name: "generic", source: "builtin" }]]),
    { cwd: "/workspace" },
  );

  runner.started[0]?.resolve(completed("still in inbox"));
  await runner.flush();
  assert.doesNotThrow(() => timers.runAll());

  assert.equal(pi.sendAttempts, 1);
  assert.equal(pi.messages.length, 0);
  assert.equal(manager.get("job-1")?.state, "completed");

  pi.sendError = undefined;
  manager.collect("job-1");
  assert.equal(pi.sendAttempts, 1);
  assert.equal(manager.get("job-1")?.state, "collected");
  cleanup();
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='delivery failure' test/tools.test.ts
```

Expected: FAIL because `timers.runAll()` propagates `delivery unavailable`.

- [ ] **Step 4: Catch delivery errors at the notifier boundary**

In `src/index.ts`, wrap only the `pi.sendMessage()` call in `flush`:

```typescript
    try {
      pi.sendMessage({
        customType: "simple-subagents-ready",
        content: `${summary}\nCheck their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.`,
        display: true,
        details: { jobIds },
      }, { deliverAs: "followUp", triggerTurn: true });
    } catch {
      // Delivery is best-effort; jobs remain available through status and the dashboard.
    }
```

Do not put candidates back into `pending`, delete IDs from `notified`, call a manager mutation, or schedule a retry timer.

- [ ] **Step 5: Run focused and regression checks**

Run:

```bash
npx tsx --test --test-name-pattern='delivery failure|completion notifier|completion notices' test/tools.test.ts
npm run typecheck
```

Expected: PASS with one attempted send, zero delivered messages, and `job-1` still `completed` until the test explicitly collects it.

- [ ] **Step 6: Commit delivery containment**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "fix: contain completion notice delivery failures"
```

---

### Task 3: Make shutdown win races with captured flush callbacks

**Files:**
- Modify: `test/tools.test.ts:448-466`
- Modify: `src/index.ts:31-68`

**Interfaces:**
- Consumes: the existing cleanup callback returned by `installCompletionNotifier()`.
- Produces: the same `() => void` cleanup interface, now idempotently marking the notifier inactive before clearing timer and pending state.
- Guarantees: a callback captured before cleanup does not call `manager.get()`, does not send a message, and does not schedule a timer after cleanup.

- [ ] **Step 1: Add a failing captured-callback race test**

Add after `completion notifier cleanup clears a pending timer and unsubscribes`:

```typescript
test("completion notifier flush captured before cleanup becomes a shutdown no-op", () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  let listener: ((jobs: readonly Job[]) => void) | undefined;
  const manager = {
    subscribe(next: (jobs: readonly Job[]) => void) {
      listener = next;
      next([{ id: "job-1", state: "running" } as Job]);
      return () => { listener = undefined; };
    },
    get() { throw new Error("manager accessed after shutdown"); },
  } as unknown as JobManager;
  const cleanup = installCompletionNotifier(pi as never, manager, timers);

  listener?.([{ id: "job-1", state: "completed" } as Job]);
  const capturedFlush = timers.pending[0];
  assert.ok(capturedFlush);
  cleanup();

  assert.doesNotThrow(() => capturedFlush());
  assert.equal(pi.messages.length, 0);
  assert.equal(listener, undefined);
  assert.deepEqual(timers.delays, [100]);
  assert.equal(timers.pending.length, 0);
});
```

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern='completion notifier.*cleanup|captured before cleanup' test/tools.test.ts
```

Expected: FAIL with `manager accessed after shutdown` because a callback already captured by the event loop still executes the flush body.

- [ ] **Step 3: Add an inactive guard to listener, flush, and cleanup**

In `installCompletionNotifier()`, add the lifecycle flag beside `timer`:

```typescript
  let timer: unknown;
  let active = true;
```

Make the first statements in `flush`:

```typescript
  const flush = () => {
    timer = undefined;
    if (!active) return;
```

Make the first statement of the subscription listener:

```typescript
  const unsubscribe = manager.subscribe((jobs) => {
    if (!active) return;
```

Replace the cleanup body with:

```typescript
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    if (timer !== undefined) timers.clearTimer(timer);
    timer = undefined;
    pending.clear();
  };
```

Setting `active = false` before unsubscribe/timer cleanup ensures any racing listener or captured callback observes shutdown first.

- [ ] **Step 4: Run lifecycle, notifier, and type checks**

Run:

```bash
npx tsx --test --test-name-pattern='completion notifier|completion notices|queued completion' test/tools.test.ts
npm run typecheck
```

Expected: PASS. Both ordinary timer cancellation and direct invocation of a pre-cleanup callback produce no message and no post-shutdown manager access.

- [ ] **Step 5: Commit lifecycle race protection**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "fix: stop completion flushes after shutdown"
```

---

### Task 4: Document availability hints and explicit collection

**Files:**
- Modify: `README.md:11-15`

**Interfaces:**
- Consumes: the existing user workflow around `subagent_status`, `subagent_control`, and `/subagents`.
- Produces: user-facing documentation that notices are hints, current state is authoritative, and collection remains an explicit parent tool action.

- [ ] **Step 1: Verify the required documentation is absent**

Run:

```bash
grep -F "Completion notices are availability hints" README.md
```

Expected: exit status 1 because the behavior is not yet documented.

- [ ] **Step 2: Add the exact notification guidance**

After the paragraph beginning `Ask Pi naturally`, add:

```markdown
Completion notices are availability hints: a notified result may already have been collected or discarded by the time Pi processes the follow-up. Pi checks the job's current state and explicitly calls the normal collection tool only when an uncollected result is needed for the active task; otherwise no action or extra confirmation turn is required. A missed notice does not remove the result—uncollected results remain available through status and `/subagents` for the rest of the session.
```

- [ ] **Step 3: Verify the documentation and complete regression suite**

Run:

```bash
grep -F "Completion notices are availability hints" README.md
npm test
npm run typecheck
```

Expected: the grep prints the new paragraph; all tests and TypeScript checks pass.

- [ ] **Step 4: Commit notification documentation**

```bash
git add README.md
git commit -m "docs: explain subagent completion hints"
```
