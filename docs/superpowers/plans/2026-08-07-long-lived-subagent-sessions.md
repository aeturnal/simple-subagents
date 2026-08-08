# Long-Lived Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each child Pi session open for follow-ups, redirects, structured reports, result collection, and explicit close.

**Architecture:** Run children in Pi 0.82.x RPC mode. Keep RPC and process details in one `SessionRunner`, and keep generation, queue, inbox, result, and capacity rules in one `SubagentManager`. Load one controlled child extension for `subagent_report` and graceful shutdown.

**Tech Stack:** TypeScript, Node.js child processes, Pi RPC JSONL, TypeBox, `node:test`, tsx.

## Global Constraints

- Prefer direct code over abstractions. Add no dependencies and no generic RPC framework.
- Add only three production modules: `child-extension.ts`, `session-runner.ts`, and `subagent-manager.ts`.
- Update shared types directly in `types.ts`; keep lifecycle predicates private to the manager or status code.
- Preserve separate child processes, profile access rules, model/thinking selection, output bounds, and extension isolation.
- Permit four actively working generations, eight open sessions, one queued follow-up, and one uncollected result per session.
- Keep cancel, collect, and discard separate from close.
- Keep progress inbox-only. Inject help into the parent's next-turn context without starting a parent turn.
- Do not persist or reconnect children across parent reload, replacement, or exit.
- Never retain reasoning text or raw malformed RPC records.
- Do not implement suggestion-box item 18 follow-ups.
- Use test-driven development and commit after each task.

## Final File Map

**Create:**

- `src/child-extension.ts` — controlled report tool and child shutdown command.
- `src/session-runner.ts` — narrow Pi RPC process interface and implementation.
- `src/subagent-manager.ts` — all long-lived session policy.
- `test/child-extension.test.ts`
- `test/session-runner.test.ts`
- `test/subagent-manager.test.ts`
- `test/helpers/controlled-session.ts` — small test-only runner adapter.

**Modify:**

- `src/types.ts`
- `src/profile-capabilities.ts`
- `src/tools.ts`
- `src/output.ts`
- `src/job-status.ts`
- `src/live-widget.ts`
- `src/dashboard.ts`
- `src/index.ts`
- `test/profile-capabilities.test.ts`
- `test/tools.test.ts`
- `test/json-output.test.ts`
- `test/job-status.test.ts`
- `test/live-widget.test.ts`
- `test/dashboard.test.ts`
- `test/integration.test.ts`
- `README.md`

**Remove after cutover:**

- `src/process-runner.ts`, `test/process-runner.test.ts`
- `src/job-manager.ts`, `test/job-manager.test.ts`
- `src/job-lifecycle.ts`, `test/job-lifecycle.test.ts`

---

### Task 1: Add long-lived types and the controlled child extension

**Files:**

- Modify: `src/types.ts`
- Create: `src/child-extension.ts`
- Create: `test/child-extension.test.ts`

**Produces:** Session/generation/report types, `subagent_report`, and `simple-subagent-shutdown`.

- [ ] **Step 1: Add failing child-extension tests**

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
  assert.ok(report);
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

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx tsx --test test/child-extension.test.ts`

Expected: FAIL because `src/child-extension.ts` does not exist.

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

Leave the old `Job` types temporarily so existing files compile until Task 6.

- [ ] **Step 4: Implement only the controlled tool and command**

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

- [ ] **Step 5: Run the focused tests and typecheck**

Run:

```bash
npx tsx --test test/child-extension.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/child-extension.ts test/child-extension.test.ts
git commit -m "feat: add persistent subagent types and reporting"
```

---

### Task 2: Replace the one-shot runner with a narrow RPC session runner

**Files:**

- Create: `src/session-runner.ts`
- Create: `test/session-runner.test.ts`
- Modify: `src/profile-capabilities.ts`
- Modify: `test/profile-capabilities.test.ts`

**Produces:** `SessionRunner`, `RunningSubagentSession`, `PiRpcSessionRunner`, and normalized session events.

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

export interface SessionExit {
  expected: boolean;
  code: number | null;
  signal?: NodeJS.Signals;
  error?: string;
  stderr: string;
}

export interface SessionOpenOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
}

export type SessionEvent =
  | { type: "progress"; item: ProgressItem }
  | { type: "telemetry"; usage: UsageStats; model?: string }
  | { type: "report"; reportId: string; kind: ReportKind; message: string; timestamp: number }
  | { type: "settled"; result: SessionResult };

export interface RunningSubagentSession {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  close(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  readonly closed: Promise<SessionExit>;
}

export interface SessionRunner {
  open(options: SessionOpenOptions): Promise<RunningSubagentSession>;
}
```

- [ ] **Step 1: Write failing launch and RPC acceptance tests**

Use one fake child with recorded stdin writes, event-emitting stdout/stderr, and recorded signals. Assert:

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

Assert launch arguments include RPC mode, `--no-session`, `--no-extensions`, the explicit child extension, model, thinking, profile prompt, and a tool list containing `subagent_report`. Assert `shell: false` and piped stdio.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts`

Expected: FAIL because the runner and child allowlist do not exist.

- [ ] **Step 3: Add one child allowlist helper**

```ts
export const getChildLaunchToolAllowlist = (profile: AgentProfile, accessMode: AccessMode): string[] =>
  [...getLaunchToolAllowlist(profile, accessMode), "subagent_report"];
```

Keep `getLaunchToolAllowlist()` unchanged for existing discovery behavior where needed, and update discovery tests to show the exact child launch list.

- [ ] **Step 4: Implement RPC inside `session-runner.ts`, not as another module**

Use the current runner's executable fallback, temp profile prompt, UTF-8 capture, stderr bounds, and signal helpers. Change only the transport:

```ts
const send = (command: Record<string, unknown>): Promise<void> => {
  const id = `rpc-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, timer: setCommandTimer(id) });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
};
```

Handle only required Pi records:

- RPC responses resolve or reject the matching command.
- Assistant text deltas update one bounded partial preview.
- Assistant `message_end` stores the latest complete text and cumulative usage.
- Tool events emit fixed activity labels.
- `subagent_report` tool starts emit a bounded structured report using `toolCallId`.
- Reasoning events emit fixed labels and discard reasoning text.
- `agent_settled` emits one `settled` result and clears per-generation capture.
- Malformed records increment a count; raw text is discarded.

`prompt`, `steer`, and `abort` resolve on command acceptance. `closed` resolves on process exit. `close` requests the internal shutdown command, then uses one bounded TERM/KILL fallback. Keep timers injectable for deterministic tests.

- [ ] **Step 5: Add settlement, cancellation, malformed-data, and exit tests**

Verify:

- steer does not reset generation capture;
- a new idle prompt does reset it;
- abort does not emit settled before `agent_settled`;
- report IDs deduplicate later in the manager;
- malformed reasoning lines expose no raw sample;
- unexpected exit rejects pending commands and returns bounded stderr;
- close is idempotent and resolves `closed` once.

- [ ] **Step 6: Run focused verification**

Run:

```bash
npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts
npm run typecheck
```

Then run `lsp_diagnostics` on `src/session-runner.ts`, `src/child-extension.ts`, and their tests.

Expected: PASS with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/session-runner.ts src/profile-capabilities.ts test/session-runner.test.ts test/profile-capabilities.test.ts
git commit -m "feat: add persistent Pi RPC session runner"
```

---

### Task 3: Implement the complete lightweight session manager

**Files:**

- Create: `src/subagent-manager.ts`
- Create: `test/subagent-manager.test.ts`
- Create: `test/helpers/controlled-session.ts`

**Produces:** Session registry, generations, scheduling, one queued follow-up, one-result barrier, report inbox, help waiting, controls, wait, and shutdown.

**Public interface:**

```ts
start(requests, profiles, defaults): SubagentSession[];
list(): SubagentSession[];
get(id: string): SubagentSession | undefined;
send(id: string, message: string, delivery: DeliveryMode): Promise<SubagentSession>;
readInbox(id?: string): SubagentReport[];
cancel(id: string): Promise<SubagentSession>;
collect(id: string): SubagentSession;
discard(id: string): SubagentSession;
close(id: string): Promise<SubagentSession>;
closeAll(): Promise<void>;
waitFor(options: WaitForOptions): Promise<WaitResult>;
subscribe(listener): () => void;
subscribeEvents(listener): () => void;
shutdown(): Promise<void>;
```

- [ ] **Step 1: Create one small controlled test adapter**

`test/helpers/controlled-session.ts` must implement `SessionRunner` without production test hooks. It records prompts, steers, aborts, and closes; exposes `emit(event)`; and resolves `closed` when close is called.

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

- [ ] **Step 2: Write failing scheduler and result-barrier tests**

Define these local fixtures first:

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

Then verify:

```ts
test("opens eight sessions but prompts only four at once", async () => {
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  manager.start(makeRequests(8), profiles, defaults);
  await runner.flush();
  assert.equal(runner.sessions.length, 8);
  assert.equal(runner.sessions.filter((entry) => entry.prompts.length === 1).length, 4);
  assert.throws(() => manager.start(makeRequests(1), profiles, defaults), /eight open/i);
});

test("a ready result blocks one queued follow-up until collection", async () => {
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

Also assert a second queued follow-up is rejected and capacity batches fail atomically.

- [ ] **Step 3: Implement the manager with three collections**

```ts
private readonly sessions = new Map<string, InternalSession>();
private readonly ready: string[] = [];
private readonly active = new Set<string>();
```

Keep `isOpenSession`, `isWorking`, and `isWaitSatisfied` as private functions in this file. `pump()` starts FIFO work until four IDs are active. It never starts a queued follow-up while any generation result is `ready`.

Open all accepted child processes, but prompt only four. On open failure, mark that session failed and release capacity. Return structured clones from all public reads and subscriptions.

- [ ] **Step 4: Add failing send and control tests**

Verify:

- redirect calls `steer` and keeps the generation number;
- follow-up creates the next generation number;
- cancel changes running to cancelling, calls abort once, and retains the active slot until settlement;
- collect and discard keep the session open and release only the result barrier;
- close cancels active work, clears queued work, closes the child, and is idempotent;
- failed child exit keeps safe partial output collectable and releases active/open capacity.

Implement these methods directly. Do not add a command pattern, state-machine library, retry policy, persistence adapter, or priority queue.

- [ ] **Step 5: Add failing progress/help/inbox tests**

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
  assert.equal(child.prompts.at(-1), "Use target A");
});
```

- [ ] **Step 6: Implement one bounded inbox method**

Cap each report at 4 KiB with `truncateUtf8(message, 4096)`. Deduplicate by `reportId`. Keep total report bytes at or below 50 KiB by removing the oldest progress report and incrementing `omittedReports`. Never remove `pendingHelpReportId`.

A help report becomes `waiting_for_parent` only on the next settlement. A successful reply clears it; a failed prompt leaves it pending. Emit manager event `report_added` once and `session_failed` on unexpected exit.

- [ ] **Step 7: Add wait and shutdown tests**

Wait returns for completed, failed, cancelled, or waiting work without collecting or closing. `closeAll()` and `shutdown()` close all open children once, including active and opening sessions.

- [ ] **Step 8: Run focused verification**

Run:

```bash
npx tsx --test test/subagent-manager.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/subagent-manager.ts test/subagent-manager.test.ts test/helpers/controlled-session.ts
git commit -m "feat: manage persistent subagent sessions"
```

---

### Task 4: Expose messaging, controls, collection, and bounded status

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/output.ts`
- Modify: `src/job-status.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/json-output.test.ts`
- Modify: `test/job-status.test.ts`

**Produces:** `subagent_send`, `subagent_inbox`, `close`, generation-aware collection, and safe public status.

- [ ] **Step 1: Update tool test services to use `SubagentManager`**

Import `ControlledRunner` from `test/helpers/controlled-session.ts`. Keep existing profile, confirmation, clock, renderer, and privacy fixtures.

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

Validate UTF-8 byte length separately from TypeBox character length.

- [ ] **Step 3: Add only the two new schemas**

```ts
const SendParams = Type.Object({
  id: Type.String(),
  message: Type.String({ minLength: 1, maxLength: 4096 }),
  delivery: Type.Optional(StringEnum(["follow_up", "redirect"] as const, { default: "follow_up" })),
}, { additionalProperties: false });

const InboxParams = Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false });
```

Register `subagent_send` and `subagent_inbox`. Add `close` to control. Descriptions must say sessions stay open until close. Do not add batch send, pagination, filters, or message editing.

- [ ] **Step 4: Make output format one generation result**

```text
# job-1 · generation 2
Session state: open
Work state: completed
## Result
...
```

Preserve the existing combined 50 KiB cap and capture notices. Format before calling `manager.collect()`, then let collection release the full result body and unblock one follow-up.

- [ ] **Step 5: Update the public status projection**

Keep existing terminal sanitization, three-item activity limit, model/thinking meaning, usage, durations, and private-data boundary. Add only:

```ts
sessionState: SessionState;
generation: number;
workState: WorkState;
queuedFollowUp: boolean;
blockedByResult: boolean;
unreadReports: number;
resultReady: boolean;
pendingHelp?: string;
```

Never include profile prompts, full output, stderr, complete inbox entries, or raw errors in tool details.

- [ ] **Step 6: Run focused verification**

Run:

```bash
npx tsx --test test/tools.test.ts test/json-output.test.ts test/job-status.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts src/output.ts src/job-status.ts test/tools.test.ts test/json-output.test.ts test/job-status.test.ts
git commit -m "feat: expose persistent subagent messaging"
```

---

### Task 5: Update the UI and parent-session lifecycle

**Files:**

- Modify: `src/live-widget.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/index.ts`
- Modify: `test/live-widget.test.ts`
- Modify: `test/dashboard.test.ts`
- Modify: `test/tools.test.ts`

**Produces:** waiting/idle UI, help injection, replacement guards, and safe close-all shutdown.

- [ ] **Step 1: Write failing widget and dashboard tests**

Verify:

- running and queued generations retain current rows and activity;
- waiting-for-parent rows remain visible;
- terminal work lingers for five seconds;
- remaining idle sessions collapse to `N idle subagent sessions remain open`;
- dashboard details show session state, generation, work state, unread count, result readiness, and queued state;
- no new dashboard history or message controls appear.

- [ ] **Step 2: Implement only the required projection changes**

Reuse `projectJobStatus()`. Change widget filtering and labels, not its timer architecture. Keep dashboard navigation, scrolling, detail modes, and current cancel key; replace one-shot field reads with current generation fields.

- [ ] **Step 3: Write failing parent help tests**

```ts
test("help enters next-turn context once without starting a turn", async () => {
  const pi = new FakePi();
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  createSimpleSubagentsExtension({
    createManager: () => manager,
    loadConfig: async () => ({ config: { confirmWrites: false, allowThinkingOverrides: false } }),
    discoverProfiles: async () => ({ agents: [genericProfile], diagnostics: [] }),
  })(pi as never);
  const ctx = fakeContext({ hasUI: true }, pi);
  await pi.emit("session_start", {}, ctx);
  manager.start(
    [{ task: "inspect", agent: "generic", writeAccess: false }],
    new Map([["generic", genericProfile]]),
    { cwd: "/workspace" },
  );
  await runner.flush();
  const child = runner.sessions[0]!;
  child.emit({ type: "report", reportId: "h1", kind: "help_request", message: "Which target?", timestamp: 1 });
  child.emit(settled("Waiting for parent"));
  await runner.flush();

  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].options.deliverAs, "nextTurn");
  assert.equal(pi.messages[0].options.triggerTurn, undefined);
  assert.match(pi.messages[0].message.content, /job-1.*generation 1.*Which target/s);
  assert.deepEqual(pi.notifications, [["job-1 generation 1 needs parent input.", "warning"]]);
});
```

A progress report must produce no parent message. Duplicate report IDs must inject once. A failed session produces only a bounded error notification.

- [ ] **Step 4: Subscribe once per parent session in `src/index.ts`**

For help events:

```ts
ctx.ui.notify(`${event.sessionId} generation ${event.generation} needs parent input.`, "warning");
pi.sendMessage({
  customType: "simple-subagents-help",
  content: `${event.sessionId} generation ${event.generation} needs parent input: ${event.message}`,
  display: true,
}, { deliverAs: "nextTurn" });
```

Do not set `triggerTurn`. Remove the event subscription during parent shutdown or replacement.

- [ ] **Step 5: Write failing replacement and shutdown tests**

Verify:

- declining `session_before_switch` or `session_before_fork` returns `{ cancel: true }` and keeps children open;
- confirmation awaits `closeAll()` and permits replacement;
- noninteractive replacement cancels rather than abandoning children;
- `session_shutdown` closes all children without prompting;
- repeated shutdown is idempotent.

- [ ] **Step 6: Add one shared close-all guard**

Use one local helper in `src/index.ts` for switch/fork confirmation. Keep automatic shutdown separate because Pi cannot cancel reload or exit at that stage.

- [ ] **Step 7: Run focused verification**

Run:

```bash
npx tsx --test test/live-widget.test.ts test/dashboard.test.ts test/tools.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/live-widget.ts src/dashboard.ts src/index.ts test/live-widget.test.ts test/dashboard.test.ts test/tools.test.ts
git commit -m "feat: guard and display open subagent sessions"
```

---

### Task 6: Cut over completely, verify integration, and document usage

**Files:**

- Modify: `src/types.ts`
- Modify: `test/integration.test.ts`
- Modify: `README.md`
- Remove: legacy one-shot source and test files listed in the file map.

**Produces:** No legacy one-shot path, a documented user workflow, and complete verification evidence.

- [ ] **Step 1: Cut all remaining imports to the new manager and runner**

Run:

```bash
rg -n 'JobManager|PiProcessRunner|JobState|process-runner|job-manager|job-lifecycle' src test
```

Update every remaining production import. Remove legacy `Job`/`JobState` types only after no consumer remains. Delete only the six replaced source/test files listed above.

- [ ] **Step 2: Update the opt-in real integration test**

The real test must:

1. open one read-only RPC child;
2. prompt it to read `answer.txt`;
3. wait and collect generation 1;
4. send one follow-up that uses the retained context;
5. wait and collect generation 2;
6. close the child;
7. assert no writable tools were enabled and the process closed.

Run when credentials are available:

```bash
SIMPLE_SUBAGENTS_INTEGRATION=1 npx tsx --test test/integration.test.ts
```

If credentials are unavailable, leave the test opt-in and report that it was not run. Normal tests must remain offline.

- [ ] **Step 3: Update README with the exact lifecycle**

Include:

```ts
subagent_send({ id: "job-1", message: "Check the failing tests" })
subagent_send({ id: "job-1", message: "Inspect auth first", delivery: "redirect" })
subagent_inbox({ id: "job-1" })
subagent_control({ action: "collect", ids: ["job-1"] })
subagent_control({ action: "close", ids: ["job-1"] })
```

State that cancel, collect, and discard keep sessions open; only close releases them; one follow-up and one ready result are allowed; replacement is guarded; reload and exit close all children.

- [ ] **Step 4: Run the full test suite and typecheck**

```bash
npm test
npm run typecheck
git diff --check
```

Expected: PASS and no legacy one-shot imports.

- [ ] **Step 5: Run final diagnostics**

Run `lsp_diagnostics` on every changed TypeScript file, then `lens_diagnostics({ mode: "all" })`.

Expected: no blocking errors or warnings introduced by this work.

- [ ] **Step 6: Commit the cutover**

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
- [ ] Parent replacement cannot abandon children; reload and exit close them.
- [ ] All text and protocol capture remains bounded and private.
- [ ] No deferred item 18 feature or shallow lifecycle/type module was added.
- [ ] `npm test` and `npm run typecheck` pass.
