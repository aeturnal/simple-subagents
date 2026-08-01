# Subagent Completion Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove automatic subagent completion messages and make event-driven waits default to 60 seconds with a five-minute maximum.

**Architecture:** Delete the separate completion-notifier subscriber from the extension lifecycle; `JobManager.waitFor()` remains the sole explicit completion-wait path and continues resolving from manager notifications. Change only the public wait schema, the omitted-value fallback, tool guidance, and user documentation; do not alter `JobManager` settlement behavior.

**Tech Stack:** TypeScript, Pi extension API, TypeBox, Node test runner through `tsx`, TypeScript compiler.

## Global Constraints

- Emit no `simple-subagents-ready` custom message and register no renderer for it.
- Keep `subagent_status`, collection, cancellation, discard, dashboard, and job lifecycle behavior unchanged.
- Keep `subagent_wait` event-driven; do not add polling.
- `timeoutMs` minimum remains exactly `100` ms.
- `timeoutMs` default becomes exactly `60_000` ms.
- `timeoutMs` maximum becomes exactly `300_000` ms.
- A configured timeout remains an upper bound; satisfied waits return immediately.
- Timeout and abort must not cancel child jobs.
- Add no dependencies, settings, or replacement notification mechanism.

---

## File Structure

- Modify `src/index.ts`: remove completion-notifier code, renderer registration, and lifecycle wiring.
- Modify `src/tools.ts`: change wait timeout schema/default and five-minute tool guidance.
- Modify `test/tools.test.ts`: replace notifier tests with one absence regression and update timeout contract tests.
- Modify `README.md`: document the 60-second default, five-minute maximum, and early event-driven completion.

### Task 1: Remove automatic completion messages

**Files:**
- Modify: `src/index.ts:1-155`
- Test: `test/tools.test.ts:1-24,698-978,1080-1190`

**Interfaces:**
- Consumes: existing `createSimpleSubagentsExtension(dependencies?: ExtensionDependencies): (pi: ExtensionAPI) => void`.
- Produces: the same extension factory and tools/dashboard lifecycle, without `installCompletionNotifier`, `simple-subagents-ready`, or notifier-only timer dependencies.

- [ ] **Step 1: Add a failing runtime regression test**

In `test/tools.test.ts`, add this test near the other runtime lifecycle tests. It exercises the real extension and manager, waits beyond the old 100 ms debounce, and verifies both emission and registration are absent:

```ts
test("runtime does not register or emit automatic completion messages", async () => {
  const pi = new FakePi();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  createSimpleSubagentsExtension({
    createManager: () => manager,
    loadConfig: async () => ({ config: { confirmWrites: false } }),
    discoverProfiles: async () => ({
      agents: [{ ...profile, name: "generic", source: "builtin" }],
      diagnostics: [],
    }),
  })(pi as never);
  await pi.emit("session_start", {}, fakeContext({}, pi));

  manager.enqueue(
    [{ task: "finish without a message", agent: "generic", writeAccess: false }],
    new Map([["generic", { ...profile, name: "generic", source: "builtin" }]]),
    { cwd: "/workspace" },
  );
  runner.started[0]?.resolve(completed());
  await runner.flush();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(pi.sendAttempts, 0);
  assert.equal(pi.messageRenderers.has("simple-subagents-ready"), false);
  await pi.emit("session_shutdown", {}, fakeContext({}, pi));
});
```

- [ ] **Step 2: Run the regression test and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="runtime does not register or emit automatic completion messages" test/tools.test.ts
```

Expected: FAIL because the current notifier sends once and registers `simple-subagents-ready`.

- [ ] **Step 3: Remove the notifier implementation and wiring**

In `src/index.ts`:

1. Remove the `Text` import because it is used only by the deleted message renderer.
2. Remove `setTimer` and `clearTimer` from `ExtensionDependencies`.
3. Delete `TimerDependencies`, the terminal-state set, and all of `installCompletionNotifier()`.
4. In `createSimpleSubagentsExtension()`, delete the local `timers` object and `removeNotifier` variable.
5. Delete `pi.registerMessageRenderer("simple-subagents-ready", ...)`.
6. Remove notifier cleanup/installation from `session_start`.
7. Remove notifier cleanup from `session_shutdown`; retain dashboard cleanup and the existing single `manager.shutdown()` promise.

The lifecycle tail must have this shape:

```ts
pi.on("session_start", async (_event, ctx) => {
  const [loadedConfig, discovered] = await Promise.all([
    readConfig(join(resolveAgentDir(), "simple-subagents.json")),
    discoverProfiles(),
  ]);
  config = loadedConfig.config;
  profiles = new Map(discovered.agents.map((profile) => [profile.name, profile]));
  if (loadedConfig.warning) ctx.ui.notify(loadedConfig.warning, "warning");
  for (const diagnostic of discovered.diagnostics) ctx.ui.notify(diagnostic, "warning");
});

pi.on("session_shutdown", async () => {
  removeSubagentsUi();
  shutdown ??= manager.shutdown();
  await shutdown;
});
```

- [ ] **Step 4: Remove obsolete notifier tests and fake support**

In `test/tools.test.ts`:

1. Remove `installCompletionNotifier` from the `src/index` import.
2. Delete the notifier-specific test block beginning with `completion notices steer real terminal transitions` and ending with `completion notifier listener captured before cleanup becomes a shutdown no-op`.
3. Remove the old assertion that `simple-subagents-ready` is registered from `runtime reports writable confirmation requiring interactive UI`.
4. Remove `FakeTimers` if no references remain.
5. Keep only the `FakePi` message fields/methods required by the new absence regression; do not add production hooks solely for testing.

- [ ] **Step 5: Run focused and full verification for Task 1**

Run:

```bash
npx tsx --test --test-name-pattern="runtime does not register or emit automatic completion messages" test/tools.test.ts
npm run typecheck
npm test
```

Expected: the focused test passes, TypeScript reports no errors, and the complete test suite passes.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "refactor: remove subagent completion notices"
```

### Task 2: Extend event-driven wait bounds

**Files:**
- Modify: `src/tools.ts:27-34,154-177,338-344`
- Test: `test/tools.test.ts:260-305,575-585,680-698`
- Modify: `README.md:78-84`

**Interfaces:**
- Consumes: existing `WaitParams`, `waitJobs(input, services, signal?)`, and `JobManager.waitFor(options)`.
- Produces: the unchanged `subagent_wait` input shape with `timeoutMs` range `100..300_000` and omitted-value fallback `60_000`.

- [ ] **Step 1: Change timeout contract tests to the approved values**

Update `wait schema bounds IDs, condition, and timeout` to contain these exact timeout assertions:

```ts
assert.equal(schema.properties.timeoutMs.minimum, 100);
assert.equal(schema.properties.timeoutMs.maximum, 300_000);
assert.equal(schema.properties.timeoutMs.default, 60_000);
assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 100 }), true);
assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 300_000 }), true);
assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 99 }), false);
assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 300_001 }), false);
assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 100.5 }), false);
```

In `waitJobs applies defaults and returns only state snapshots`, change the expected detail to:

```ts
timeoutMs: 60_000,
```

In both description assertions, require `/at most 5 minutes/i` instead of `/at most 30 seconds/i`.

- [ ] **Step 2: Run the timeout contract tests and verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="wait schema bounds|waitJobs applies defaults|subagent_wait description|registered tools expose" test/tools.test.ts
```

Expected: FAIL showing the current `30_000` maximum, `15_000` default/fallback, and 30-second description.

- [ ] **Step 3: Implement the new schema, fallback, and guidance**

In `src/tools.ts`, change `WaitParams` to:

```ts
timeoutMs: Type.Optional(Type.Integer({
  minimum: 100,
  maximum: 300_000,
  default: 60_000,
})),
```

Change the omitted-value fallback in `waitJobs()` to:

```ts
const timeoutMs = input.timeoutMs ?? 60_000;
```

Change the middle `subagent_wait` description sentence to:

```ts
"The wait lasts at most 5 minutes, returns as soon as the requested condition is satisfied, and never collects output or cancels jobs.",
```

Keep the existing advice against immediately repeating a timed-out wait.

- [ ] **Step 4: Update user documentation**

Replace the `README.md` wait paragraph with:

```md
`subagent_wait` is an event-driven pause for jobs expected to finish when no useful parent work can proceed. The parent cannot answer concurrently while the tool is waiting, so each call defaults to 60 seconds and lasts at most 5 minutes. The wait returns immediately when its requested jobs settle; the configured timeout is only an upper bound. A timeout returns current states without cancelling work; do not immediately wait again—continue other work or return control. Aborting the parent turn does not cancel subagents. When the parent is not waiting, use `subagent_status` or the dashboard to check progress.
```

Do not edit historical design documents; the approved superseding spec records why their old values and notification behavior no longer apply.

- [ ] **Step 5: Verify focused behavior, type safety, and the full suite**

Run:

```bash
npx tsx --test --test-name-pattern="wait schema bounds|waitJobs applies defaults|subagent_wait description|waitFor any settles|waitFor all ignores" test/tools.test.ts test/job-manager.test.ts
npm run typecheck
npm test
git diff --check
```

Expected: focused tests pass, waits still settle from manager notifications before timeout, TypeScript reports no errors, the complete suite passes, and the diff has no whitespace errors.

- [ ] **Step 6: Confirm removed notification and old timeout text are absent from shipped files**

Run:

```bash
rg -n "Jobs may be ready|simple-subagents-ready|installCompletionNotifier|at most 30 seconds|defaults to 15 seconds" src test README.md
```

Expected: no matches.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/tools.ts test/tools.test.ts README.md
git commit -m "feat: extend subagent wait duration"
```

## Final Verification

Run fresh checks after both task commits:

```bash
npm run typecheck
npm test
git diff --check
git status --short
```

Then run Pi Lens diagnostics on `src/index.ts`, `src/tools.ts`, and `test/tools.test.ts`. Expected: no blocking diagnostics; all tests pass; the working tree is clean.
