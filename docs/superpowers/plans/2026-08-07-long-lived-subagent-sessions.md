# Long-Lived Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each child Pi session open for follow-ups, redirects, structured reports, result collection, and explicit close.

**Architecture:** Run children in Pi 0.82.x RPC mode. Keep process and RPC details in one `SessionRunner`, and keep generation, queue, inbox, result, and capacity rules in one `SubagentManager`. Load one controlled child extension for reporting and graceful shutdown.

**Tech Stack:** TypeScript, Node.js child processes, Pi RPC JSONL, TypeBox, `node:test`, tsx.

## Global Constraints

- Prefer direct code over abstractions. Add no dependencies and no generic RPC framework.
- Add only three production modules: `child-extension.ts`, `session-runner.ts`, and `subagent-manager.ts`.
- Update shared types directly in `types.ts`; keep small lifecycle predicates private.
- Preserve separate child processes, profile access rules, model/thinking selection, output bounds, and extension isolation.
- Permit four active generations, eight open sessions, one queued follow-up, and one uncollected result per session.
- Keep cancel, collect, and discard separate from close.
- Keep progress inbox-only. Inject help into the parent's next-turn context without starting a parent turn.
- Do not persist or reconnect children across parent reload, replacement, or exit.
- Never retain reasoning text or raw malformed RPC records.
- Do not implement suggestion-box item 18 follow-ups.
- Every task must leave its focused tests passing and end with an independently reviewable commit.

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

**Remove after cutover:**

- `src/process-runner.ts`, `test/process-runner.test.ts`
- `src/job-manager.ts`, `test/job-manager.test.ts`
- `src/job-lifecycle.ts`, `test/job-lifecycle.test.ts`

---

### Task 1: Add long-lived types and the controlled child extension

**Testable change:** The package defines the new data contract, and an isolated child can intentionally report progress, request help, or shut down.

**Files:**

- Modify: `src/types.ts`
- Create: `src/child-extension.ts`
- Create: `test/child-extension.test.ts`

- [ ] **Step 1: Write failing child-extension tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import childExtension, { CHILD_SHUTDOWN_COMMAND, REPORT_MAX_BYTES } from "../src/child-extension.ts";

test("progress continues and help terminates the child run", async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  childExtension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as never);

  const report = tools.get("subagent_report");
  assert.equal((await report.execute("p1", { kind: "progress", message: "halfway" })).terminate, undefined);
  assert.equal((await report.execute("h1", { kind: "help_request", message: "Which target?" })).terminate, true);
  assert.equal(REPORT_MAX_BYTES, 4096);
  assert.ok(commands.has(CHILD_SHUTDOWN_COMMAND));
});

test("the shutdown command requests graceful shutdown", async () => {
  let calls = 0;
  const commands = new Map<string, any>();
  childExtension({ registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command) } as never);
  await commands.get(CHILD_SHUTDOWN_COMMAND).handler("", { shutdown: () => { calls += 1; } });
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run the test and confirm failure**

Run: `npx tsx --test test/child-extension.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add the essential types directly to `src/types.ts`**

Keep existing profile, request, launch, usage, progress, and truncation types. Add:

```ts
export type SessionState = "opening" | "open" | "closing" | "closed" | "failed";
export type WorkState = "queued" | "running" | "cancelling" | "waiting_for_parent" | "completed" | "cancelled" | "failed";
export type ResultState = "none" | "ready" | "collected" | "discarded";
export type DeliveryMode = "follow_up" | "redirect";
export type ReportKind = "progress" | "help_request";

export interface SubagentReport {
  id: string;
  generation: number;
  kind: ReportKind;
  message: string;
  timestamp: number;
  read: boolean;
}

export interface Generation {
  number: number;
  instruction: string;
  state: WorkState;
  resultState: ResultState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: ProgressItem[];
  output: string;
  resultPreview?: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  outputTruncation?: TextTruncation;
  stderrTruncation?: TextTruncation;
  errorTruncation?: TextTruncation;
  malformedEventCount: number;
}

export interface SubagentSession {
  id: string;
  request: JobRequest;
  profile: AgentProfile;
  state: SessionState;
  createdAt: number;
  closedAt?: number;
  generations: Generation[];
  queuedFollowUp?: { generation: number; instruction: string; createdAt: number };
  reports: SubagentReport[];
  reportBytes: number;
  omittedReports: number;
  pendingHelpReportId?: string;
  launchModel?: string;
  launchThinkingLevel?: ThinkingLevel;
  launchThinkingSource?: LaunchThinkingSource;
}
```

Leave legacy `Job` types until the final cutover.

- [ ] **Step 4: Implement only the report tool and shutdown command**

```ts
export const REPORT_MAX_BYTES = 4 * 1024;
export const CHILD_SHUTDOWN_COMMAND = "simple-subagent-shutdown";

export default function childExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_report",
    label: "Report to Parent",
    description: "Send a milestone or stop and ask the parent for required context.",
    promptGuidelines: [
      "Use subagent_report progress only at meaningful milestones.",
      "Use subagent_report help_request alone when parent input is required before continuing.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["progress", "help_request"] as const),
      message: Type.String({ minLength: 1, maxLength: REPORT_MAX_BYTES }),
    }, { additionalProperties: false }),
    async execute(_id, input) {
      const message = truncateUtf8(input.message, REPORT_MAX_BYTES).text;
      return {
        content: [{ type: "text", text: input.kind === "help_request" ? "Waiting for parent reply." : "Progress reported." }],
        details: { kind: input.kind, message },
        ...(input.kind === "help_request" ? { terminate: true } : {}),
      };
    },
  });

  pi.registerCommand(CHILD_SHUTDOWN_COMMAND, {
    description: "Internal simple-subagents shutdown command",
    handler: async (_args, ctx) => { ctx.shutdown(); },
  });
}
```

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test test/child-extension.test.ts
npm run typecheck
git add src/types.ts src/child-extension.ts test/child-extension.test.ts
git commit -m "feat: add persistent subagent types and reporting"
```

---

### Task 2: Add RPC process launch, commands, and shutdown

**Testable change:** A child RPC process can open, accept prompt/steer/abort commands, report command rejection, and close safely. Event capture is intentionally deferred to Task 3.

**Files:**

- Create: `src/session-runner.ts`
- Create: `test/session-runner.test.ts`
- Modify: `src/profile-capabilities.ts`
- Modify: `test/profile-capabilities.test.ts`

**Interfaces:**

```ts
export interface SessionOpenOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
}

export interface SessionExit {
  expected: boolean;
  code: number | null;
  signal?: NodeJS.Signals;
  error?: string;
  stderr: string;
}

export interface RunningSubagentSession {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
  readonly closed: Promise<SessionExit>;
}

export interface SessionRunner {
  open(options: SessionOpenOptions): Promise<RunningSubagentSession>;
}
```

- [ ] **Step 1: Write failing launch and command tests**

Use a fake child with recorded stdin writes, event-emitting stdout/stderr, and recorded signals:

```ts
const opening = runner.open(openOptions());
const ready = JSON.parse(child.stdin.writes[0]);
assert.equal(ready.type, "get_state");
child.respond(ready.id, "get_state", { isStreaming: false });
const session = await opening;

const accepted = session.prompt("generation one");
const prompt = JSON.parse(child.stdin.writes.at(-1));
assert.deepEqual({ type: prompt.type, message: prompt.message }, { type: "prompt", message: "generation one" });
child.respond(prompt.id, "prompt");
await accepted;
```

Also test `steer`, `abort`, a failed RPC response, pending-command rejection on process exit, and idempotent close.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts`

Expected: FAIL because the runner and child allowlist do not exist.

- [ ] **Step 3: Add one child allowlist helper**

```ts
export const getChildLaunchToolAllowlist = (profile: AgentProfile, accessMode: AccessMode): string[] =>
  [...getLaunchToolAllowlist(profile, accessMode), "subagent_report"];
```

Keep the base allowlist helper unchanged.

- [ ] **Step 4: Implement command correlation in `session-runner.ts`**

Use the current executable fallback, temp profile prompt, cwd, model, thinking, `shell: false`, and piped stdio. Resolve the controlled extension path with:

```ts
const childExtensionPath = fileURLToPath(new URL("./child-extension.ts", import.meta.url));
```

Keep the command map private:

```ts
const send = (command: Record<string, unknown>): Promise<void> => {
  const id = `rpc-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, timer: setCommandTimer(id) });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
};
```

At this checkpoint, parse response records only. Ignore non-response events until Task 3. Discard malformed lines without retaining their text. Give command acceptance one injected timeout.

- [ ] **Step 5: Implement bounded process close**

`close()` sends the internal shutdown command, waits for exit, then uses one TERM/KILL fallback. It resolves the single `closed` promise exactly once. Unexpected exit rejects every pending command and returns bounded stderr.

- [ ] **Step 6: Verify and commit**

```bash
npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts
npm run typecheck
git add src/session-runner.ts src/profile-capabilities.ts test/session-runner.test.ts test/profile-capabilities.test.ts
git commit -m "feat: add persistent RPC process control"
```

---

### Task 3: Add normalized RPC activity and settlement events

**Testable change:** `SessionRunner` converts Pi events into bounded progress, telemetry, structured reports, and one final per-generation result.

**Files:**

- Modify: `src/session-runner.ts`
- Modify: `test/session-runner.test.ts`

**Event contract:**

```ts
export interface SessionResult {
  output: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  malformedEventCount: number;
  outputTruncation?: TextTruncation;
  stderrTruncation?: TextTruncation;
  errorTruncation?: TextTruncation;
}

export type SessionEvent =
  | { type: "progress"; item: ProgressItem }
  | { type: "telemetry"; usage: UsageStats; model?: string }
  | { type: "report"; reportId: string; kind: ReportKind; message: string; timestamp: number }
  | { type: "settled"; result: SessionResult };

export interface RunningSubagentSession {
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
```

- [ ] **Step 1: Write failing event-reduction tests**

Verify:

- text deltas form one bounded partial preview;
- assistant `message_end` replaces partial output with authoritative text;
- usage accumulates within one generation;
- tool events use fixed activity labels;
- `subagent_report` uses `toolCallId`, kind, and bounded message;
- reasoning deltas produce only `Model reasoning` labels;
- `agent_settled` emits one result;
- a new idle prompt resets capture, while steer does not.

Example:

```ts
const events: SessionEvent[] = [];
session.subscribe((event) => events.push(event));
child.event({ type: "tool_execution_start", toolCallId: "r1", toolName: "subagent_report", args: { kind: "progress", message: "halfway" } });
assert.deepEqual(events.at(-1), {
  type: "report",
  reportId: "r1",
  kind: "progress",
  message: "halfway",
  timestamp: now,
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx tsx --test test/session-runner.test.ts`

Expected: FAIL because non-response events are not reduced.

- [ ] **Step 3: Add one private event reducer**

Reduce only required Pi events. Reuse existing UTF-8 capture and usage parsing from `process-runner.ts`. Reset generation capture only after an accepted idle prompt. On `agent_settled`, emit the result and clear active capture.

Malformed records increment a counter but retain no raw sample. Reasoning content is never copied into progress, errors, stderr, or diagnostics.

- [ ] **Step 4: Add cancellation and malformed-data tests**

Assert abort acceptance does not settle work. Only `agent_settled` emits settlement. Split valid JSON across chunks, send multibyte text, and verify malformed reasoning input cannot appear in any normalized event.

- [ ] **Step 5: Verify and commit**

```bash
npx tsx --test test/session-runner.test.ts
npm run typecheck
git add src/session-runner.ts test/session-runner.test.ts
git commit -m "feat: normalize persistent subagent events"
```

---

### Task 4: Add manager scheduling, generations, results, and controls

**Testable change:** Eight sessions can remain open, only four work at once, generations continue in context, and result/control rules work without reporting or inbox behavior yet.

**Files:**

- Create: `src/subagent-manager.ts`
- Create: `test/subagent-manager.test.ts`
- Create: `test/helpers/controlled-session.ts`

**Initial public interface:**

```ts
start(requests, profiles, defaults): SubagentSession[];
list(): SubagentSession[];
get(id: string): SubagentSession | undefined;
send(id: string, message: string, delivery: DeliveryMode): Promise<SubagentSession>;
cancel(id: string): Promise<SubagentSession>;
collect(id: string): SubagentSession;
discard(id: string): SubagentSession;
close(id: string): Promise<SubagentSession>;
subscribe(listener): () => void;
```

- [ ] **Step 1: Create the controlled test runner**

It records prompts, steers, aborts, and closes; exposes `emit(event)`; and resolves `closed` on close.

```ts
export const settled = (output: string): SessionEvent => ({
  type: "settled",
  result: {
    output,
    stderr: "",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    stopReason: "stop",
    malformedEventCount: 0,
  },
});
```

- [ ] **Step 2: Write failing capacity and result-barrier tests**

```ts
test("opens eight sessions but prompts only four", async () => {
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  manager.start(makeRequests(8), profiles, defaults);
  await runner.flush();
  assert.equal(runner.sessions.length, 8);
  assert.equal(runner.sessions.filter((entry) => entry.prompts.length === 1).length, 4);
  assert.throws(() => manager.start(makeRequests(1), profiles, defaults), /eight open/i);
});

test("a ready result blocks one queued follow-up", async () => {
  const { runner, manager, child } = await runningManager();
  await manager.send("job-1", "generation two", "follow_up");
  child.emit(settled("generation one"));
  await runner.flush();
  assert.equal(child.prompts.length, 1);
  manager.collect("job-1");
  await runner.flush();
  assert.deepEqual(child.prompts, ["Task 1", "generation two"]);
});
```

Define the local fixtures explicitly:

```ts
const profile: AgentProfile = {
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  source: "user",
};
const profiles = new Map([[profile.name, profile]]);
const defaults = { cwd: "/workspace", parentModel: "parent/model", thinkingLevel: "high" as const };
const makeRequests = (count: number): JobRequest[] =>
  Array.from({ length: count }, (_, index) => ({ task: `Task ${index + 1}`, agent: profile.name, writeAccess: false }));

const runningManager = async () => {
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  manager.start(makeRequests(1), profiles, defaults);
  await runner.flush();
  return { runner, manager, child: runner.sessions[0]! };
};
```

- [ ] **Step 3: Implement the smallest scheduler**

```ts
private readonly sessions = new Map<string, InternalSession>();
private readonly ready: string[] = [];
private readonly active = new Set<string>();
```

Keep lifecycle predicates private. `pump()` starts FIFO work until four IDs are active. It does not start a queued follow-up while any result is ready. Return structured clones from public reads and subscriptions.

- [ ] **Step 4: Add failing send and control tests**

Verify:

- one follow-up is accepted and a second is rejected;
- redirect calls steer and keeps the generation number;
- cancel changes running to cancelling and keeps the active slot until settlement;
- collect and discard keep the session open and release the result barrier;
- close cancels active work, clears queued work, closes the child, and is idempotent;
- open failure or child exit releases capacity and leaves safe output collectable.

- [ ] **Step 5: Implement controls directly**

Do not add a command pattern, state-machine library, retry policy, persistence adapter, or priority queue. Subscribe to runner settlement and exit once per child, update the current generation, notify, and pump.

- [ ] **Step 6: Verify and commit**

```bash
npx tsx --test test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts test/helpers/controlled-session.ts
git commit -m "feat: schedule persistent subagent generations"
```

---

### Task 5: Add manager reports, help flow, wait, and shutdown

**Testable change:** Children can report progress or request help; inbox reads, wait, close-all, and shutdown work without changing core scheduling code.

**Files:**

- Modify: `src/subagent-manager.ts`
- Modify: `test/subagent-manager.test.ts`

**Additional interface:**

```ts
readInbox(id?: string): SubagentReport[];
waitFor(options: WaitForOptions): Promise<WaitResult>;
subscribeEvents(listener): () => void;
closeAll(): Promise<void>;
shutdown(): Promise<void>;
```

- [ ] **Step 1: Write failing progress and help tests**

```ts
test("progress remains inbox-only", async () => {
  const { manager, child } = await runningManager();
  child.emit({ type: "report", reportId: "r1", kind: "progress", message: "halfway", timestamp: 10 });
  assert.equal(manager.get("job-1")?.generations[0]?.state, "running");
  assert.deepEqual(manager.readInbox("job-1").map((report) => report.message), ["halfway"]);
  assert.deepEqual(manager.readInbox("job-1"), []);
});

test("help waits after settlement and resumes the same generation", async () => {
  const { runner, manager, child } = await runningManager();
  child.emit({ type: "report", reportId: "r2", kind: "help_request", message: "Which target?", timestamp: 20 });
  child.emit(settled("Waiting for parent"));
  await runner.flush();
  assert.equal(manager.get("job-1")?.generations[0]?.state, "waiting_for_parent");
  await manager.send("job-1", "Use target A", "follow_up");
  assert.equal(manager.get("job-1")?.generations.at(-1)?.number, 1);
});
```

- [ ] **Step 2: Implement one bounded inbox method**

Cap each report at 4 KiB with `truncateUtf8(message, 4096)`. Deduplicate by report ID. Keep total report bytes at or below 50 KiB by removing the oldest progress report and incrementing `omittedReports`. Never remove the active help request.

A help report becomes waiting only on the next settlement. A successful reply clears it; a failed prompt leaves it pending. Emit `report_added` once and `session_failed` on unexpected exit.

- [ ] **Step 3: Add failing wait tests**

Wait returns for completed, failed, cancelled, or waiting work. It does not collect, discard, cancel, or close. Preserve current any/all, timeout, and abort semantics.

- [ ] **Step 4: Add failing close-all and shutdown tests**

Verify all open, opening, active, waiting, and idle children close exactly once. Repeated shutdown returns the same promise and never leaves reserved capacity.

- [ ] **Step 5: Implement wait and shutdown using existing manager subscriptions**

Reuse the current event-driven waiter pattern from `job-manager.ts`. Do not add polling, background intervals, durable queues, or a second manager.

- [ ] **Step 6: Verify and commit**

```bash
npx tsx --test test/subagent-manager.test.ts
npm run typecheck
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: add subagent reports and help flow"
```

---

### Task 6: Expose messaging, collection, controls, and bounded status

**Testable change:** The parent model can send, read, collect, cancel, discard, close, and inspect generation-aware state through stable tools.

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/output.ts`
- Modify: `src/job-status.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/json-output.test.ts`
- Modify: `test/job-status.test.ts`

- [ ] **Step 1: Update tool test services to use `SubagentManager`**

Import the controlled runner. Keep existing profile, confirmation, clock, renderer, and privacy fixtures.

- [ ] **Step 2: Write failing tool tests**

```ts
test("send defaults to one queued follow-up", async () => {
  const result = await sendInstruction({ id: "job-1", message: "Check tests" }, services);
  assert.match(text(result), /generation 2 queued/i);
});

test("inbox reads unread reports once", async () => {
  assert.match(text(await readInbox({ id: "job-1" }, services)), /Which target/);
  assert.match(text(await readInbox({ id: "job-1" }, services)), /No unread reports/);
});

test("collect does not close but close does", async () => {
  await controlJobs({ action: "collect", ids: ["job-1"] }, services);
  assert.equal(services.manager.get("job-1")?.state, "open");
  await controlJobs({ action: "close", ids: ["job-1"] }, services);
  assert.equal(services.manager.get("job-1")?.state, "closed");
});
```

- [ ] **Step 3: Add only two new schemas**

```ts
const SendParams = Type.Object({
  id: Type.String(),
  message: Type.String({ minLength: 1, maxLength: 4096 }),
  delivery: Type.Optional(StringEnum(["follow_up", "redirect"] as const, { default: "follow_up" })),
}, { additionalProperties: false });

const InboxParams = Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false });
```

Validate UTF-8 byte length separately. Register `subagent_send`, `subagent_inbox`, and control `close`. Do not add batching, filters, pagination, or message editing.

- [ ] **Step 4: Make collection format one generation**

```text
# job-1 · generation 2
Session state: open
Work state: completed
## Result
...
```

Format before calling collect. Preserve the combined 50 KiB cap and capture notices. Collection releases the full body and unblocks one follow-up.

- [ ] **Step 5: Update the public status projection**

Keep sanitization, three activity items, usage, durations, model/thinking meaning, and private-data boundaries. Add only session state, generation, work state, queued/blocked flags, unread count, result readiness, and bounded pending help.

- [ ] **Step 6: Verify and commit**

```bash
npx tsx --test test/tools.test.ts test/json-output.test.ts test/job-status.test.ts
npm run typecheck
git add src/tools.ts src/output.ts src/job-status.ts test/tools.test.ts test/json-output.test.ts test/job-status.test.ts
git commit -m "feat: expose persistent subagent messaging"
```

---

### Task 7: Update UI and parent-session lifecycle

**Testable change:** Open and waiting sessions are visible, help is delivered once, and parent replacement cannot abandon children.

**Files:**

- Modify: `src/live-widget.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/index.ts`
- Modify: `test/live-widget.test.ts`
- Modify: `test/dashboard.test.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Write failing widget and dashboard tests**

Verify running/queued rows, waiting visibility, five-second terminal linger, one idle-open summary line, and session/generation details. Do not add dashboard history or message controls.

- [ ] **Step 2: Implement projection-only UI changes**

Reuse `projectJobStatus()`. Change widget filtering and labels, not timer architecture. Keep dashboard navigation, scrolling, details, and cancel key.

- [ ] **Step 3: Write failing help delivery tests**

Emit one help report and settlement from the controlled runner. Assert:

```ts
assert.equal(pi.messages.length, 1);
assert.equal(pi.messages[0].options.deliverAs, "nextTurn");
assert.equal(pi.messages[0].options.triggerTurn, undefined);
assert.match(pi.messages[0].message.content, /job-1.*generation 1.*Which target/s);
assert.deepEqual(pi.notifications, [["job-1 generation 1 needs parent input.", "warning"]]);
```

Progress emits no parent message. Duplicate reports inject once. Session failure creates only one bounded error notification.

- [ ] **Step 4: Subscribe once per parent session**

```ts
ctx.ui.notify(`${event.sessionId} generation ${event.generation} needs parent input.`, "warning");
pi.sendMessage({
  customType: "simple-subagents-help",
  content: `${event.sessionId} generation ${event.generation} needs parent input: ${event.message}`,
  display: true,
}, { deliverAs: "nextTurn" });
```

Do not set `triggerTurn`. Remove the subscription during shutdown or replacement.

- [ ] **Step 5: Write failing replacement and shutdown tests**

Declining switch/fork confirmation cancels replacement. Confirmation awaits close-all. Noninteractive replacement cancels. `session_shutdown` closes all without prompting and is idempotent.

- [ ] **Step 6: Add one local close-all guard in `src/index.ts`**

Use it for `session_before_switch` and `session_before_fork`. Keep automatic shutdown separate because reload/exit cannot be cancelled at that stage.

- [ ] **Step 7: Verify and commit**

```bash
npx tsx --test test/live-widget.test.ts test/dashboard.test.ts test/tools.test.ts
npm run typecheck
git add src/live-widget.ts src/dashboard.ts src/index.ts test/live-widget.test.ts test/dashboard.test.ts test/tools.test.ts
git commit -m "feat: guard and display open subagent sessions"
```

---

### Task 8: Complete cutover, integration, documentation, and cleanup

**Testable change:** No legacy path remains, the real opt-in workflow proves context continuation, and full offline verification passes.

**Files:**

- Modify: `src/types.ts`
- Modify: `test/integration.test.ts`
- Modify: `README.md`
- Remove: legacy files listed in the file map.

- [ ] **Step 1: Find and remove legacy imports**

```bash
rg -n 'JobManager|PiProcessRunner|JobState|process-runner|job-manager|job-lifecycle' src test
```

Update every remaining import. Remove legacy `Job` types only after no consumer remains. Delete only the six replaced files.

- [ ] **Step 2: Update the opt-in real integration test**

Open one read-only RPC child, collect generation 1, send one follow-up using retained context, collect generation 2, close, and assert no writable tools or live process remain.

Run when credentials are available:

```bash
SIMPLE_SUBAGENTS_INTEGRATION=1 npx tsx --test test/integration.test.ts
```

Keep normal tests offline.

- [ ] **Step 3: Update README with exact usage**

```ts
subagent_send({ id: "job-1", message: "Check the failing tests" })
subagent_send({ id: "job-1", message: "Inspect auth first", delivery: "redirect" })
subagent_inbox({ id: "job-1" })
subagent_control({ action: "collect", ids: ["job-1"] })
subagent_control({ action: "close", ids: ["job-1"] })
```

State that cancel, collect, and discard keep sessions open; only close releases them; one follow-up and one result are retained; replacement is guarded; reload/exit closes all.

- [ ] **Step 4: Run complete verification**

```bash
npm test
npm run typecheck
git diff --check
```

Run `lsp_diagnostics` on all changed TypeScript files, then `lens_diagnostics({ mode: "all" })`.

Expected: all checks pass and no legacy one-shot import remains.

- [ ] **Step 5: Commit**

```bash
git add src test README.md
git commit -m "feat: keep subagent sessions open for follow-up work"
```

---

## Final Review Checklist

- [ ] Every child stays open after terminal work.
- [ ] Four-active and eight-open limits hold through cancellation.
- [ ] Only one follow-up and one uncollected result are retained.
- [ ] Redirect and help reply keep the current generation.
- [ ] Progress is inbox-only; help injects once without starting a turn.
- [ ] Cancel, collect, and discard keep the child open.
- [ ] Close cancels active work and exits the child.
- [ ] Parent replacement cannot abandon children; reload/exit closes them.
- [ ] All text and protocol capture remains bounded and private.
- [ ] No deferred item 18 feature or shallow lifecycle/type module was added.
- [ ] `npm test` and `npm run typecheck` pass.
