# Long-Lived Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Complete one task, run its focused verification, review it, and commit it before starting the next task.

**Goal:** Keep each child Pi session open for follow-ups, redirects, structured reports, result collection, and explicit close.

**Architecture:** Run children in Pi 0.82.x RPC mode. Keep process and RPC behavior in `SessionRunner`. Keep open-session, generation, capacity, result, inbox, and help policy in `SubagentManager`. Load one controlled child extension for reporting and graceful shutdown.

**Tech Stack:** TypeScript, Node.js child processes, Pi RPC JSONL, TypeBox, `node:test`, tsx.

## Scope Rules

- Add no dependency, persistence, reconnect support, generic RPC layer, or autonomous child loop.
- Add only three production modules: `child-extension.ts`, `session-runner.ts`, and `subagent-manager.ts`.
- Keep small predicates and internal interfaces inside those modules or `types.ts`.
- Allow four active generations, eight open sessions, one queued follow-up, and one uncollected result per session.
- Cancel, collect, and discard never close a session. Only close releases it.
- Progress is inbox-only. Help is injected into the parent's next-turn context without starting a turn.
- Reload and exit close all children. Session replacement is blocked until the user confirms close-all.
- Bound all captured text. Never retain reasoning text or raw malformed RPC records.
- Do not implement deferred suggestion-box item 18 features.
- Each task below has one behavioral acceptance target and a focused passing test set.

## Final File Map

**Create:**

- `src/child-extension.ts`
- `src/session-runner.ts`
- `src/subagent-manager.ts`
- `test/child-extension.test.ts`
- `test/session-runner.test.ts`
- `test/subagent-manager.test.ts`
- `test/helpers/controlled-session.ts`

**Modify:**

- `src/types.ts`
- `src/profile-capabilities.ts`
- `src/tools.ts`
- `src/output.ts`
- `src/job-status.ts`
- `src/live-widget.ts`
- `src/dashboard.ts`
- `src/index.ts`
- related tests
- `test/integration.test.ts`
- `README.md`

**Remove only after cutover:**

- `src/process-runner.ts`, `test/process-runner.test.ts`
- `src/job-manager.ts`, `test/job-manager.test.ts`
- `src/job-lifecycle.ts`, `test/job-lifecycle.test.ts`

---

## Phase A: Controlled child and RPC transport

### Task 1: Add the controlled child report extension

**Testable change:** The isolated child exposes exactly one report tool and one internal shutdown command.

**Files:** Modify `src/types.ts`; create `src/child-extension.ts`; create `test/child-extension.test.ts`.

- [ ] Add `ReportKind = "progress" | "help_request"` and the 4 KiB report limit.
- [ ] Write failing tests asserting progress continues, help returns `terminate: true`, oversized UTF-8 text is bounded, and the shutdown command calls `ctx.shutdown()`.
- [ ] Register `subagent_report` with strict TypeBox parameters and `simple-subagent-shutdown` with no public workflow behavior.
- [ ] Run:

```bash
npx tsx --test test/child-extension.test.ts
npm run typecheck
git add src/types.ts src/child-extension.ts test/child-extension.test.ts
git commit -m "feat: add controlled child reporting"
```

Expected: focused tests and typecheck pass.

---

### Task 2: Launch an RPC child and wait for readiness

**Testable change:** `SessionRunner.open()` spawns the correct isolated Pi command and resolves only after `get_state` succeeds.

**Files:** Create `src/session-runner.ts`; create `test/session-runner.test.ts`; modify `src/profile-capabilities.ts` and its test.

- [ ] Define `SessionRunner`, `RunningSubagentSession`, `SessionOpenOptions`, `SessionExit`, `SessionResult`, and the final `SessionEvent` union in `session-runner.ts`.
- [ ] Add a fake child-process harness that records args, stdin, stderr, signals, and exit.
- [ ] Write a failing test asserting RPC mode, `--no-session`, `--no-extensions`, the controlled extension path, model, thinking, profile prompt, child tool allowlist, `shell: false`, and piped stdio.
- [ ] Add `getChildLaunchToolAllowlist()` by appending only `subagent_report` to the existing access-aware allowlist.
- [ ] Implement spawn plus a bounded `get_state` readiness command. Do not implement prompt or event reduction yet.
- [ ] Run:

```bash
npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts
npm run typecheck
git add src/session-runner.ts src/profile-capabilities.ts test/session-runner.test.ts test/profile-capabilities.test.ts
git commit -m "feat: launch persistent RPC children"
```

---

### Task 3: Accept the first RPC prompt

**Testable change:** An open child accepts one prompt command and reports RPC rejection or timeout to the caller.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for command ID correlation, successful prompt acceptance, rejected responses, split stdout chunks, and command timeout.
- [ ] Add one private pending-command map and JSONL line buffer.
- [ ] Implement `prompt(message)` using `{ type: "prompt", message }`. Resolve on command acceptance, not generation settlement.
- [ ] Discard malformed response lines without retaining raw text; event handling remains deferred.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="prompt|response|timeout" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: accept RPC child prompts"
```

---

### Task 4: Add redirect and abort RPC controls

**Testable change:** A running child can accept an urgent steer or cancellation request without being considered settled.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests asserting `steer(message)` sends `steer`, `abort()` sends `abort`, and neither emits a settlement event.
- [ ] Implement both methods through the Task 3 command map. Keep them idempotent only where Pi's command contract is idempotent.
- [ ] Assert a rejected steer or abort rejects its returned promise while leaving the process open.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="steer|abort" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: control active RPC child turns"
```

---

### Task 5: Gracefully close an RPC child

**Testable change:** `close()` requests internal shutdown and applies a bounded TERM/KILL fallback exactly once.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for internal shutdown, clean exit, TERM fallback, KILL fallback, and repeated close.
- [ ] Implement one `closed` promise and idempotent `close()` path.
- [ ] Preserve the current signal helpers; do not expose the raw child process.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="graceful close|TERM|KILL" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: close persistent RPC children"
```

---

### Task 6: Handle unexpected RPC child exit

**Testable change:** Unexpected process loss rejects pending work and returns one bounded exit record.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for exit during readiness, exit with pending commands, nonzero exit, signal exit, and bounded stderr.
- [ ] Resolve `closed` once with `expected: false` and reject every pending command.
- [ ] Do not treat unexpected exit as graceful close or retain unbounded stderr.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="unexpected exit|pending command|bounded stderr" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: report RPC child process loss"
```

---

## Phase B: Normalized child events

### Task 7: Capture bounded assistant output

**Testable change:** Assistant deltas produce one bounded partial preview, and `message_end` produces authoritative final text.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for multiple deltas, authoritative replacement, UTF-8 boundaries, and output truncation metadata.
- [ ] Add only the assistant-output branch of the private event reducer.
- [ ] Reuse `truncateUtf8`; do not retain duplicate full-message history.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="assistant output|text delta|truncation" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: capture bounded RPC output"
```

---

### Task 8: Normalize safe activity labels

**Testable change:** Tool and reasoning activity is visible through fixed labels without retaining arguments or reasoning text.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for fixed tool labels, reasoning redaction, unknown tools, and activity ordering.
- [ ] Emit bounded `progress` events. Map reasoning to `Model reasoning` and discard its content.
- [ ] Retain no tool arguments except the controlled report handled in Task 10.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="activity|tool label|reasoning" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: normalize safe RPC activity"
```

---

### Task 9: Accumulate model and usage telemetry

**Testable change:** Each generation exposes cumulative model, token, cost, and turn telemetry.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for model identity, cumulative token/cache counts, cost, turns, and repeated message-end records.
- [ ] Emit bounded `telemetry` events from authoritative assistant message records.
- [ ] Keep telemetry separate from output and activity capture.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="telemetry|usage|model identity" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: accumulate RPC usage telemetry"
```

---

### Task 10: Normalize structured child reports

**Testable change:** A controlled report tool call becomes one bounded report event identified by its Pi tool-call ID.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for progress/help kinds, 4 KiB UTF-8 truncation, missing fields, unrelated tools, and repeated Pi records with the same `toolCallId`.
- [ ] Emit `{ type: "report", reportId, kind, message, timestamp }` from `subagent_report` start events.
- [ ] Ignore invalid controlled-report payloads and never fall back to raw tool arguments.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="structured report" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: normalize child report events"
```

---

### Task 11: Settle and reset one generation

**Testable change:** `agent_settled` emits one final generation result; the next idle prompt resets capture, while steer does not.

**Files:** Modify `src/session-runner.ts` and `test/session-runner.test.ts`.

- [ ] Write failing tests for single settlement, duplicate settlement suppression, abort-before-settlement, prompt reset, steer retention, malformed-line count, and safe error bounds.
- [ ] Emit the final `settled` event with output, stderr, usage, model, stop reason, error, truncation metadata, and malformed count.
- [ ] Reset capture only after an accepted idle prompt. Never settle merely because abort was accepted.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="settled|reset|malformed" test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: settle RPC child generations"
```

---

## Phase C: Session manager policy

### Task 12: Register open sessions and enforce the open limit

**Testable change:** A batch opens atomically when capacity allows, and the ninth open session is rejected before any process starts.

**Files:** Modify `src/types.ts`; create `src/subagent-manager.ts`; create `test/subagent-manager.test.ts`; create `test/helpers/controlled-session.ts`.

- [ ] Add session, generation, work, and result state types to `types.ts`.
- [ ] Create a controlled runner that records calls and emits normalized events without production test hooks.
- [ ] Write failing tests for stable IDs, eight accepted opens, atomic ninth rejection, open failure, snapshots, and structured cloning.
- [ ] Implement only the session registry, `enqueue`, `list`, `get`, and open-capacity accounting. Do not prompt children yet.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="open session|open limit|snapshot" test/subagent-manager.test.ts
npm run typecheck
git add src/types.ts src/subagent-manager.ts test/subagent-manager.test.ts test/helpers/controlled-session.ts
git commit -m "feat: register persistent subagent sessions"
```

---

### Task 13: Schedule four active generations FIFO

**Testable change:** Eight children may be open, but only the first four generation prompts run until a slot is released.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for four active prompts, FIFO start order, settlement releasing one slot, prompt failure releasing one slot, and active-slot retention while cancelling.
- [ ] Add one ready queue, one active-ID set, and one private `pump()` method.
- [ ] Prompt generation 1 for at most four sessions. Do not add follow-ups yet.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="active limit|FIFO|slot" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: schedule four active subagents"
```

---

### Task 14: Continue generations with follow-up or redirect

**Testable change:** Follow-up creates the next generation; redirect steers the current generation.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for generation numbering, one queued follow-up, second-follow-up rejection, redirect during running work, and redirect rejection while idle.
- [ ] Implement `send(id, message, delivery)` with `follow_up` as the default policy value.
- [ ] Follow-up uses a later prompt and consumes scheduler capacity. Redirect uses steer and does not increment generation.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="follow-up|redirect|generation" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: continue subagent generations"
```

---

### Task 15: Enforce the result barrier and release results

**Testable change:** One ready result blocks the queued follow-up until that result is collected or discarded.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for ready-result retention, blocked follow-up, collect release, discard release, repeated collect/discard rejection, and session remaining open.
- [ ] Implement `collect` and `discard`. Neither method closes, cancels, or starts a parent turn.
- [ ] Keep one full result and one bounded preview. Start the queued follow-up only after the barrier is released.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="result barrier|collect|discard" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: retain one subagent result"
```

---

### Task 16: Cancel active work without closing the session

**Testable change:** Cancel requests abort once, retain capacity until settlement, and leave the child open afterward.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for running-to-cancelling transition, one abort call, repeated cancel, settlement to cancelled, queued-work cancellation, and open-session retention.
- [ ] Implement `cancel(id)` independently from close.
- [ ] Do not release the active slot on abort acceptance; release it only on settlement or child exit.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="cancel" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: cancel subagent work without closing"
```

---

### Task 17: Explicitly close one session

**Testable change:** Close cancels active work, clears queued work, exits the child, and releases one open-session slot.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for idle, active, opening, and repeated close plus queued-follow-up removal.
- [ ] Implement `close(id)` with one closing-to-closed transition.
- [ ] Keep close distinct from cancel, collect, and discard.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="explicit close|closing state" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: close persistent subagent sessions"
```

---

### Task 18: Handle unexpected child failure

**Testable change:** Child loss marks the session failed, releases capacity, and preserves bounded collectable partial output.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for failure while opening, running, cancelling, and idle plus bounded error and capacity release.
- [ ] Handle unexpected runner `closed` resolution separately from explicit close.
- [ ] Preserve safe partial output, usage, truncation, and failure metadata.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="child failure|unexpected close" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: retain failed subagent results"
```

---

### Task 19: Store a bounded progress inbox

**Testable change:** Progress is readable once from a bounded per-session inbox and does not change work state.

**Files:** Modify `src/types.ts`, `src/subagent-manager.ts`, and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for unread/read behavior, per-session and all-session reads, report-ID deduplication, 4 KiB item bounds, 50 KiB total bounds, oldest-progress eviction, and omitted count.
- [ ] Add reports, report bytes, and omitted-report fields to session snapshots.
- [ ] Implement `readInbox(id?)`. Emit one internal `report_added` event but no parent message.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="progress inbox|report bounds" test/subagent-manager.test.ts
npm run typecheck
git add src/types.ts src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: store bounded subagent progress"
```

---

### Task 20: Pause for help and resume the same generation

**Testable change:** Help becomes waiting after settlement, and the parent's reply resumes the same generation rather than creating another one.

**Files:** Modify `src/types.ts`, `src/subagent-manager.ts`, and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for pending help before settlement, waiting after settlement, help retention during inbox eviction, same-generation reply, failed reply acceptance, and duplicate report IDs.
- [ ] Add `pendingHelpReportId` and `waiting_for_parent` policy.
- [ ] Treat the next follow-up while waiting as the help reply. Clear pending help only after prompt acceptance.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="help request|waiting for parent|help reply" test/subagent-manager.test.ts
npm run typecheck
git add src/types.ts src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: pause subagents for parent help"
```

---

### Task 21: Wait for session work without consuming it

**Testable change:** `waitFor()` observes terminal or waiting work with any/all, timeout, and abort behavior but performs no control action.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Port focused wait tests for immediate result, any, all, timeout, abort, unknown IDs, and waiting-for-parent.
- [ ] Implement wait using manager subscriptions and injected timers, not polling.
- [ ] Assert waiting never collects, discards, cancels, closes, or marks inbox entries read.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="waitFor|wait for" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: wait for persistent subagent work"
```

---

### Task 22: Close all sessions during manager shutdown

**Testable change:** `closeAll()` and `shutdown()` close every opening, active, waiting, idle, and failed-but-open child exactly once.

**Files:** Modify `src/subagent-manager.ts` and `test/subagent-manager.test.ts`.

- [ ] Write failing tests for mixed-state close-all, repeated calls, concurrent calls, no open sessions, and final zero capacity.
- [ ] Implement one shared in-flight shutdown promise. Await all child closes with `Promise.allSettled`.
- [ ] Keep `closeAll()` callable by parent replacement and `shutdown()` callable by extension exit.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="closeAll|shutdown" test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: close all persistent subagents"
```

---

## Phase D: Public tools and presentation

### Task 23: Project bounded generation-aware status

**Testable change:** Status functions expose current session/generation state without exposing output, stderr, prompts, or raw errors.

**Files:** Modify `src/job-status.ts` and `test/job-status.test.ts`.

- [ ] Add tests for session state, generation number, work state, queue/result flags, unread count, bounded pending help, model/thinking, usage, durations, and three-item activity cap.
- [ ] Add a temporary overload accepting both legacy `Job` and new `SubagentSession` so this commit typechecks before runtime cutover.
- [ ] Preserve terminal sanitization and privacy boundaries.
- [ ] Run:

```bash
npx tsx --test test/job-status.test.ts
npm run typecheck
git add src/job-status.ts test/job-status.test.ts
git commit -m "feat: project persistent subagent status"
```

---

### Task 24: Format one generation result

**Testable change:** Collection formats one generation with bounded output, capture notices, usage, and open-session state.

**Files:** Modify `src/output.ts` and `test/json-output.test.ts`.

- [ ] Add tests for generation heading, session/work states, result/error sections, model/thinking, truncation notices, and combined 50 KiB cap.
- [ ] Add a temporary formatter overload for legacy `Job` until Task 35 removes the old path.
- [ ] Keep formatting pure: it must not mutate result state or close a session.
- [ ] Run:

```bash
npx tsx --test test/json-output.test.ts
npm run typecheck
git add src/output.ts test/json-output.test.ts
git commit -m "feat: format subagent generation results"
```

---

### Task 25: Cut existing tools and runtime construction to `SubagentManager`

**Testable change:** Existing agents, run, status, wait, cancel, collect, and discard workflows use the persistent manager without adding the new tools yet.

**Files:** Modify `src/tools.ts`, `src/index.ts`, and `test/tools.test.ts`.

- [ ] Replace tool-test process fixtures with the controlled session runner and update existing assertions for session/generation snapshots.
- [ ] Change `ToolServices.manager`, start/status/wait/control calls, and extension construction from `JobManager`/`PiProcessRunner` to `SubagentManager`/`PiRpcSessionRunner`.
- [ ] Keep existing tool names and request schemas unchanged in this task.
- [ ] Assert completed work remains open after collect and session shutdown calls manager shutdown.
- [ ] Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "refactor: use persistent manager for existing tools"
```

---

### Task 26: Add the send tool

**Testable change:** The parent can submit one follow-up or one urgent redirect through a strict public schema.

**Files:** Modify `src/tools.ts` and `test/tools.test.ts`.

- [ ] Add the `subagent_send` schema and validate UTF-8 byte length separately.
- [ ] Test default follow-up, explicit redirect, queued/rejected replies, unknown IDs, and private tool details.
- [ ] Add no batch sending or message editing.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="subagent_send" test/tools.test.ts
npm run typecheck
git add src/tools.ts test/tools.test.ts
git commit -m "feat: expose subagent send tool"
```

---

### Task 27: Add the inbox tool

**Testable change:** The parent can read unread progress/help reports once for one or all sessions.

**Files:** Modify `src/tools.ts` and `test/tools.test.ts`.

- [ ] Add the strict `subagent_inbox` schema.
- [ ] Test one-session reads, all-session reads, empty reads, read-once behavior, omitted count, and private details.
- [ ] Add no filters, pagination, or history API.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="subagent_inbox" test/tools.test.ts
npm run typecheck
git add src/tools.ts test/tools.test.ts
git commit -m "feat: expose subagent inbox tool"
```

---

### Task 28: Add explicit close control

**Testable change:** The control tool can explicitly close sessions, while cancel, collect, and discard continue to leave them open.

**Files:** Modify `src/tools.ts` and `test/tools.test.ts`.

- [ ] Add failing tests for close on idle, running, and already-closed sessions, plus non-closing cancel/collect/discard assertions.
- [ ] Add `close` to the control schema, execution switch, summary, and renderer.
- [ ] Keep close confirmation policy unchanged; parent replacement confirmation belongs to Task 33.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="control close|keeps session open" test/tools.test.ts
npm run typecheck
git add src/tools.ts test/tools.test.ts
git commit -m "feat: expose explicit subagent close"
```

---

### Task 29: Wire generation-aware collection

**Testable change:** Collection formats the ready generation before releasing it and then permits one queued follow-up to start.

**Files:** Modify `src/tools.ts`, `src/output.ts`, `test/tools.test.ts`, and `test/json-output.test.ts`.

- [ ] Add failing tests for ready-generation selection, format-before-release, bounded payload, repeated collection rejection, and queued-work release.
- [ ] Format the selected ready generation, then call manager collect. Do not close the session.
- [ ] Keep discard output-free and preserve the formatter behavior proven in Task 24.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="generation collection|result release" test/tools.test.ts test/json-output.test.ts
npm run typecheck
git add src/tools.ts src/output.ts test/tools.test.ts test/json-output.test.ts
git commit -m "feat: collect subagent generations"
```

---

### Task 30: Display persistent sessions in the live widget

**Testable change:** The compact widget distinguishes active, queued, waiting, terminal-linger, and idle-open sessions.

**Files:** Modify `src/live-widget.ts` and `test/live-widget.test.ts`.

- [ ] Test running/queued rows, waiting visibility, five-second terminal linger, and one idle-open summary line.
- [ ] Reuse `projectJobStatus()` and preserve timer ownership.
- [ ] Do not add interaction or new timers.
- [ ] Run:

```bash
npx tsx --test test/live-widget.test.ts
npm run typecheck
git add src/live-widget.ts test/live-widget.test.ts
git commit -m "feat: display persistent sessions in widget"
```

---

### Task 31: Display persistent sessions in the dashboard

**Testable change:** Dashboard rows and details show generation, work, result, queue, and unread-report state.

**Files:** Modify `src/dashboard.ts` and `test/dashboard.test.ts`.

- [ ] Test idle/waiting rows, generation details, unread/result indicators, and safe bounded previews.
- [ ] Preserve navigation, scrolling, detail modes, and the existing cancel key.
- [ ] Add no history, send controls, or keybindings.
- [ ] Run:

```bash
npx tsx --test test/dashboard.test.ts
npm run typecheck
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "feat: display persistent sessions in dashboard"
```

---

## Phase E: Parent lifecycle

### Task 32: Deliver help into the parent's next-turn context

**Testable change:** A help event notifies the human and injects one bounded next-turn message without starting a turn.

**Files:** Modify `src/index.ts` and `test/tools.test.ts`.

- [ ] Add tests for one warning, `deliverAs: "nextTurn"`, no `triggerTurn`, duplicate suppression, no progress injection, bounded failure notification, and listener cleanup.
- [ ] Subscribe once to manager events during parent-session startup.
- [ ] Send a visible custom message containing session ID, generation, and bounded help text.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="parent help|next-turn" test/tools.test.ts
npm run typecheck
git add src/index.ts test/tools.test.ts
git commit -m "feat: deliver subagent help to parent"
```

---

### Task 33: Guard switch and fork replacement

**Testable change:** A parent switch or fork cannot abandon open child sessions.

**Files:** Modify `src/index.ts` and `test/tools.test.ts`.

- [ ] Test declined and accepted `session_before_switch`, declined and accepted `session_before_fork`, and noninteractive cancellation.
- [ ] Add one local confirmation helper that awaits `closeAll()` before permitting replacement.
- [ ] Do not change reload or exit handling in this task.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="session_before_switch|session_before_fork" test/tools.test.ts
npm run typecheck
git add src/index.ts test/tools.test.ts
git commit -m "feat: guard parent session replacement"
```

---

### Task 34: Close children during parent shutdown

**Testable change:** Parent reload or exit closes all child sessions and removes manager event listeners without prompting.

**Files:** Modify `src/index.ts` and `test/tools.test.ts`.

- [ ] Test `session_shutdown` with running, waiting, and idle children; repeated shutdown; close failure; and listener cleanup.
- [ ] Await manager shutdown without asking for confirmation because shutdown cannot be cancelled at this stage.
- [ ] Keep switch/fork confirmation behavior unchanged from Task 33.
- [ ] Run:

```bash
npx tsx --test --test-name-pattern="session_shutdown|listener cleanup" test/tools.test.ts
npm run typecheck
git add src/index.ts test/tools.test.ts
git commit -m "feat: close subagents on parent shutdown"
```

---

## Phase F: Cutover and verification

### Task 35: Remove the legacy one-shot implementation

**Testable change:** Production and offline tests contain no legacy manager, runner, lifecycle, or one-shot type path.

**Files:** Modify `src/types.ts` and any remaining imports; remove the six legacy source/test files listed above.

- [ ] Run this inventory before deleting anything:

```bash
rg -n 'JobManager|PiProcessRunner|JobState|process-runner|job-manager|job-lifecycle' src test
```

- [ ] Move any still-relevant assertion into the new focused tests, remove temporary legacy overloads, then delete only the listed files.
- [ ] Verify no matches remain and the complete offline suite passes:

```bash
npm test
npm run typecheck
rg -n 'JobManager|PiProcessRunner|JobState|process-runner|job-manager|job-lifecycle' src test && exit 1 || true
git add src test
git commit -m "refactor: remove one-shot subagent path"
```

---

### Task 36: Prove context continuation with the opt-in integration test

**Testable change:** A real read-only child answers generation 1, uses retained context in generation 2, and closes cleanly.

**Files:** Modify `test/integration.test.ts`.

- [ ] Update the test to open one RPC child, read `answer.txt`, collect generation 1, send a context-dependent follow-up, collect generation 2, and close.
- [ ] Assert no writable tools were enabled and the child process exited.
- [ ] Keep the test skipped unless `SIMPLE_SUBAGENTS_INTEGRATION=1` is set.
- [ ] Run when credentials are available:

```bash
SIMPLE_SUBAGENTS_INTEGRATION=1 npx tsx --test test/integration.test.ts
```

If credentials are unavailable, run the normal skipped form and record that limitation:

```bash
npx tsx --test test/integration.test.ts
```

- [ ] Commit:

```bash
git add test/integration.test.ts
git commit -m "test: cover persistent subagent context"
```

---

### Task 37: Document the public lifecycle

**Testable change:** README examples and stated limits match the implemented tool schemas and behavior.

**Files:** Modify `README.md`.

- [ ] Document send, redirect, inbox, collect, discard, cancel, and close with exact tool examples.
- [ ] State the four-active/eight-open limits, one-follow-up/one-result bounds, help behavior, replacement confirmation, and reload/exit shutdown.
- [ ] Check every documented tool name and control action against `src/tools.ts`:

```bash
rg -n 'subagent_(run|send|inbox|status|wait|control)|follow_up|redirect|collect|discard|cancel|close' README.md src/tools.ts
npm run typecheck
git diff --check
git add README.md
git commit -m "docs: explain persistent subagent sessions"
```

---

## Final Verification Gate

This is a review gate, not another implementation task.

- [ ] Run:

```bash
npm test
npm run typecheck
git diff --check
```

- [ ] Run `lsp_diagnostics` on every changed TypeScript file and `lens_diagnostics({ mode: "all" })`.
- [ ] Review the final diff against `docs/superpowers/specs/2026-08-07-long-lived-subagent-sessions-design.md` and confirm no deferred item 18 feature was added.
- [ ] Confirm `git status --short` contains no unintended files.

## Final Acceptance Checklist

- [ ] Every child remains open after terminal work.
- [ ] Four-active and eight-open limits hold through cancellation and failure.
- [ ] Only one queued follow-up and one uncollected result are retained.
- [ ] Follow-up creates a generation; redirect and help reply do not.
- [ ] Progress is inbox-only; help injects once without starting a parent turn.
- [ ] Wait, cancel, collect, and discard do not close.
- [ ] Explicit close and parent shutdown exit children safely.
- [ ] Replacement cannot abandon open children.
- [ ] Output, stderr, errors, reports, and inbox totals are bounded.
- [ ] Reasoning text and malformed raw records are never retained.
- [ ] No legacy one-shot path or deferred enhancement remains.
- [ ] Offline tests, typecheck, diff check, LSP diagnostics, and lens diagnostics pass.
