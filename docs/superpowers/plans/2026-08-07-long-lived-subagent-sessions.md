# Long-Lived Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep each child Pi session open for follow-ups, redirects, progress reports, help requests, result collection, and explicit close.

**Architecture:** Replace one-shot print processes with a small `SessionRunner` over Pi 0.82.x RPC mode. Put generation, queue, inbox, result, and capacity policy in `SubagentManager`; keep transport details out of that manager. Use one controlled child extension for structured reports and graceful shutdown.

**Tech Stack:** TypeScript, Node.js child processes, Pi 0.82.x RPC JSONL protocol, TypeBox, `node:test`, tsx.

## Global Constraints

- Keep the implementation small and direct. Do not add dependencies or a general RPC framework.
- Use Pi's existing RPC commands and events; do not invent another child protocol.
- Keep separate child processes and disable unrelated extension discovery.
- Permit exactly four actively working generations and eight open sessions.
- Permit one queued normal follow-up and one uncollected result per session.
- Keep cancel, collect, and discard separate from close.
- Do not persist or reconnect children across parent reload, replacement, or exit.
- Do not infer control messages from normal assistant prose.
- Bound report text at 4 KiB, each inbox at 50 KiB, and captured results at the existing 50 KiB limit.
- Never retain reasoning text or raw malformed protocol records.
- Follow test-driven development: add one failing behavior test, confirm the failure, add the smallest implementation, and rerun the focused test.
- Do not add deferred dashboard history, multi-result archives, multi-follow-up queues, configurable shutdown policy, or stress infrastructure.

## File Structure

### New files

- `src/session-types.ts` — long-lived session, generation, report, and runner event types.
- `src/session-lifecycle.ts` — small pure lifecycle predicates used by manager, status, and UI.
- `src/child-extension.ts` — controlled `subagent_report` tool and internal shutdown command loaded only in children.
- `src/session-runner.ts` — Pi RPC subprocess adapter and its narrow interface.
- `src/subagent-manager.ts` — session registry, four-slot scheduler, generation rules, inbox, wait, and controls.
- `test/session-lifecycle.test.ts` — pure state-policy tests.
- `test/child-extension.test.ts` — controlled extension contract tests.
- `test/session-runner.test.ts` — RPC transport, event reduction, cancellation, exit, and close tests.
- `test/subagent-manager.test.ts` — scheduling, generations, reports, results, wait, and shutdown tests.
- `test/helpers/controlled-session.ts` — shared test-only `SessionRunner` adapter for manager, tool, and runtime tests.

### Modified files

- `src/types.ts` — retain shared profile, launch, usage, progress, and request types; remove legacy one-shot `Job` types after cutover.
- `src/tools.ts` — use `SubagentManager`; add `subagent_send`, `subagent_inbox`, and `close` control.
- `src/job-status.ts` — project long-lived session and current-generation status without exposing private state.
- `src/output.ts` — format one generation result and release full collected bodies.
- `src/live-widget.ts` — render active, queued, waiting, lingering, and idle-open summary states.
- `src/dashboard.ts` — inspect the new session snapshot; do not add a generation-history browser.
- `src/index.ts` — create the new runner/manager, inject help requests, guard replacement, and close all on shutdown.
- `src/profile-capabilities.ts` — add the controlled report tool to child launch allowlists.
- `test/tools.test.ts`, `test/job-status.test.ts`, `test/json-output.test.ts`, `test/live-widget.test.ts`, `test/dashboard.test.ts` — update public behavior tests.
- `test/integration.test.ts` — exercise a real RPC child, a follow-up, and explicit close when integration testing is enabled.
- `README.md` — document the open-session lifecycle and new tools.

### Removed after cutover

- `src/process-runner.ts`, `test/process-runner.test.ts` — replaced by `SessionRunner`.
- `src/job-manager.ts`, `test/job-manager.test.ts` — replaced by `SubagentManager`.
- `src/job-lifecycle.ts`, `test/job-lifecycle.test.ts` — replaced by separate session/work lifecycle policy.

---

### Task 1: Add the essential session data model

**Files:**

- Create: `src/session-types.ts`
- Create: `src/session-lifecycle.ts`
- Create: `test/session-lifecycle.test.ts`
- Modify later, not in this task: `src/types.ts`

**Interfaces:**

- Consumes: `AgentProfile`, `JobRequest`, `ProgressItem`, `TextTruncation`, and `UsageStats` from `src/types.ts`.
- Produces: `SessionState`, `WorkState`, `ResultState`, `DeliveryMode`, `ReportKind`, `SubagentReport`, `Generation`, `SubagentSession`, `SessionEvent`, `SessionExit`, `isOpenSession()`, `isWorking()`, and `isWaitSatisfied()`.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isOpenSession, isWaitSatisfied, isWorking } from "../src/session-lifecycle.ts";

test("only opening, open, and closing sessions reserve open capacity", () => {
  assert.equal(isOpenSession("opening"), true);
  assert.equal(isOpenSession("open"), true);
  assert.equal(isOpenSession("closing"), true);
  assert.equal(isOpenSession("closed"), false);
  assert.equal(isOpenSession("failed"), false);
});

test("cancelling work keeps its active slot until settlement", () => {
  assert.equal(isWorking("running"), true);
  assert.equal(isWorking("cancelling"), true);
  assert.equal(isWorking("waiting_for_parent"), false);
});

test("wait returns for parent help and terminal work", () => {
  assert.equal(isWaitSatisfied("waiting_for_parent"), true);
  assert.equal(isWaitSatisfied("completed"), true);
  assert.equal(isWaitSatisfied("cancelled"), true);
  assert.equal(isWaitSatisfied("failed"), true);
  assert.equal(isWaitSatisfied("queued"), false);
  assert.equal(isWaitSatisfied("running"), false);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npx tsx --test test/session-lifecycle.test.ts`

Expected: FAIL because `src/session-lifecycle.ts` does not exist.

- [ ] **Step 3: Add the minimal types and pure predicates**

```ts
// src/session-types.ts
import type {
  AgentProfile,
  JobRequest,
  LaunchThinkingSource,
  ProgressItem,
  TextTruncation,
  ThinkingLevel,
  UsageStats,
} from "./types.js";

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

export type SessionEvent =
  | { type: "progress"; item: ProgressItem }
  | { type: "telemetry"; usage: UsageStats; model?: string }
  | { type: "report"; reportId: string; kind: ReportKind; message: string; timestamp: number }
  | {
      type: "settled";
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
    };

export interface SessionExit {
  expected: boolean;
  code: number | null;
  signal?: NodeJS.Signals;
  error?: string;
  stderr: string;
}
```

```ts
// src/session-lifecycle.ts
import type { SessionState, WorkState } from "./session-types.js";

export const isOpenSession = (state: SessionState): boolean =>
  state === "opening" || state === "open" || state === "closing";

export const isWorking = (state: WorkState): boolean =>
  state === "running" || state === "cancelling";

export const isWaitSatisfied = (state: WorkState): boolean =>
  state === "waiting_for_parent" || state === "completed" || state === "cancelled" || state === "failed";
```

- [ ] **Step 4: Run the focused test**

Run: `npx tsx --test test/session-lifecycle.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the model**

```bash
git add src/session-types.ts src/session-lifecycle.ts test/session-lifecycle.test.ts
git commit -m "feat: add long-lived subagent state model"
```

---

### Task 2: Add the controlled child reporting extension

**Files:**

- Create: `src/child-extension.ts`
- Create: `test/child-extension.test.ts`

**Interfaces:**

- Consumes: `ReportKind` from `src/session-types.ts`, `truncateUtf8()` from `src/output.ts`, Pi `ExtensionAPI`, and TypeBox.
- Produces: default child extension, tool name `subagent_report`, command name `simple-subagent-shutdown`, exported constants `REPORT_MAX_BYTES = 4096` and `CHILD_SHUTDOWN_COMMAND`.

- [ ] **Step 1: Write failing tool-contract tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import childExtension, { CHILD_SHUTDOWN_COMMAND, REPORT_MAX_BYTES } from "../src/child-extension.ts";

test("progress reports continue and help requests terminate the child run", async () => {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  childExtension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  } as never);

  const report = tools.get("subagent_report");
  assert.ok(report);
  assert.equal((await report.execute("progress-1", { kind: "progress", message: "halfway" })).terminate, undefined);
  assert.equal((await report.execute("help-1", { kind: "help_request", message: "Which target?" })).terminate, true);
  assert.equal(REPORT_MAX_BYTES, 4096);
  assert.ok(commands.has(CHILD_SHUTDOWN_COMMAND));
});

test("the internal shutdown command requests graceful shutdown", async () => {
  let shutdownCalls = 0;
  const commands = new Map<string, any>();
  childExtension({ registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command) } as never);
  await commands.get(CHILD_SHUTDOWN_COMMAND).handler("", { shutdown: () => { shutdownCalls += 1; } });
  assert.equal(shutdownCalls, 1);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `npx tsx --test test/child-extension.test.ts`

Expected: FAIL because `src/child-extension.ts` does not exist.

- [ ] **Step 3: Implement only the report tool and shutdown command**

```ts
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateUtf8 } from "./output.js";

export const REPORT_MAX_BYTES = 4 * 1024;
export const CHILD_SHUTDOWN_COMMAND = "simple-subagent-shutdown";

export default function childExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "subagent_report",
    label: "Report to Parent",
    description: "Send a short progress update or stop and ask the parent for required context.",
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

- [ ] **Step 4: Run the focused test**

Run: `npx tsx --test test/child-extension.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the child extension**

```bash
git add src/child-extension.ts test/child-extension.test.ts
git commit -m "feat: add controlled child reporting extension"
```

---

### Task 3: Implement the narrow Pi RPC session runner

**Files:**

- Create: `src/session-runner.ts`
- Create: `test/session-runner.test.ts`
- Modify: `src/profile-capabilities.ts`
- Test: `test/profile-capabilities.test.ts`

**Interfaces:**

- Consumes: `SessionEvent`, `SessionExit`, shared launch/profile/request types, `JsonLineParser`, output bounds, and `getChildLaunchToolAllowlist()`.
- Produces: `SessionOpenOptions`, `RunningSubagentSession`, `SessionRunner`, `PiRpcSessionRunner`, and injectable spawn/timer interfaces. `src/profile-capabilities.ts` produces `getChildLaunchToolAllowlist(profile, accessMode)`, which returns the existing permitted built-ins plus `subagent_report` without changing the base allowlist function.

```ts
export interface SessionOpenOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
}

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

- [ ] **Step 1: Write failing launch and command tests**

Use a fake child with writable `stdin`, event-emitting `stdout`/`stderr`, and recorded signals. Assert:

```ts
const opening = runner.open(openOptions());
const getState = JSON.parse(child.stdin.writes[0]);
assert.equal(getState.type, "get_state");
child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: getState.id, type: "response", command: "get_state", success: true, data: { isStreaming: false } })}\n`));
const session = await opening;

const promptAccepted = session.prompt("generation one");
const prompt = JSON.parse(child.stdin.writes.at(-1));
assert.deepEqual({ type: prompt.type, message: prompt.message }, { type: "prompt", message: "generation one" });
child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: prompt.id, type: "response", command: "prompt", success: true })}\n`));
await promptAccepted;
```

Also assert the spawn arguments include:

```ts
["--mode", "rpc", "--no-session", "--no-extensions", "--extension", childExtensionPath]
```

and that the final `--tools` value contains `subagent_report` but preserves read-only or writable profile capabilities. Implement that composition as:

```ts
export const getChildLaunchToolAllowlist = (profile: AgentProfile, accessMode: AccessMode): string[] =>
  [...getLaunchToolAllowlist(profile, accessMode), "subagent_report"];
```

Resolve the controlled extension with `fileURLToPath(new URL("./child-extension.ts", import.meta.url))`. Also assert `shell: false`, piped stdin/stdout/stderr, working directory, model, thinking, and temporary profile prompt arguments remain correct.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts`

Expected: FAIL because the runner and report allowlist do not exist.

- [ ] **Step 3: Implement one in-file RPC command map and event reducer**

Keep transport private inside `session-runner.ts`:

```ts
interface PendingCommand {
  resolve(): void;
  reject(error: Error): void;
}

const send = (command: Record<string, unknown>): Promise<void> => {
  const id = `rpc-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
};
```

Reduce only the Pi events required by the spec:

- `message_update` text deltas -> bounded partial progress;
- assistant `message_end` -> latest complete output and cumulative usage;
- `tool_execution_start` for `subagent_report` -> normalized report event using `toolCallId`;
- tool start/update/end -> fixed activity labels;
- reasoning events -> fixed activity labels, never reasoning text;
- `agent_settled` -> one settled result and reset per-generation capture.

Reset output, usage, model, stop reason, errors, and malformed count after each accepted idle `prompt`, but not after `steer`. Preserve the existing UTF-8 capture bounds and temporary profile-prompt cleanup. Use the current executable/script fallback logic so installed Pi, Node-launched Pi, and the existing integration harness still work.

Discard raw malformed records and increment a count. Give pending RPC commands one injected bounded acceptance timer for deterministic tests. Do not introduce a reusable RPC client class or separate transport package.

- [ ] **Step 4: Add cancellation, unexpected exit, and bounded close tests**

Cover these exact outcomes:

```ts
await session.abort(); // writes { type: "abort" }
child.stdout.emit("data", Buffer.from('{"type":"agent_settled"}\n'));
// manager-facing settled event occurs only now

const closing = session.close();
// close requests /simple-subagent-shutdown, then escalates only if the process remains alive
child.close(0);
await closing;
assert.equal((await session.closed).expected, true);
```

For unexpected exit, close the fake child before an RPC response and assert the command rejects, `closed.expected` is false, stderr is bounded, and all pending commands settle.

- [ ] **Step 5: Run the runner tests**

Run: `npx tsx --test test/session-runner.test.ts test/profile-capabilities.test.ts`

Expected: PASS.

- [ ] **Step 6: Run proactive diagnostics**

Run: `lsp_diagnostics` on `src/session-runner.ts`, `src/child-extension.ts`, and their tests.

Expected: no TypeScript errors.

- [ ] **Step 7: Commit the runner**

```bash
git add src/session-runner.ts src/profile-capabilities.ts test/session-runner.test.ts test/profile-capabilities.test.ts
git commit -m "feat: add Pi RPC session runner"
```

---

### Task 4: Implement session scheduling, generations, results, and wait

**Files:**

- Create: `src/subagent-manager.ts`
- Create: `test/subagent-manager.test.ts`
- Create: `test/helpers/controlled-session.ts`

**Interfaces:**

- Consumes: `SessionRunner`, `RunningSubagentSession`, launch resolution, session types, lifecycle predicates, and existing output bounds.
- Produces: `SubagentManager`, `WaitForOptions`, `WaitResult`, shared test adapter `ControlledRunner`, and manager methods used by later tasks:

```ts
start(requests, profiles, defaults): SubagentSession[];
list(): SubagentSession[];
get(id: string): SubagentSession | undefined;
send(id: string, message: string, delivery: DeliveryMode): Promise<SubagentSession>;
cancel(id: string): Promise<SubagentSession>;
collect(id: string): SubagentSession;
discard(id: string): SubagentSession;
close(id: string): Promise<SubagentSession>;
closeAll(): Promise<void>;
waitFor(options: WaitForOptions): Promise<WaitResult>;
subscribe(listener): () => void;
shutdown(): Promise<void>;
```

- [ ] **Step 1: Write a controlled session-runner test adapter**

The adapter opens sessions immediately, records prompts and steers, and lets tests emit normalized events:

```ts
// test/helpers/controlled-session.ts
export class ControlledSession implements RunningSubagentSession {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  abortCalls = 0;
  closeCalls = 0;
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private resolveClosed!: (exit: SessionExit) => void;
  readonly closed = new Promise<SessionExit>((resolve) => { this.resolveClosed = resolve; });

  async prompt(message: string): Promise<void> { this.prompts.push(message); }
  async steer(message: string): Promise<void> { this.steers.push(message); }
  async abort(): Promise<void> { this.abortCalls += 1; }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.resolveClosed({ expected: true, code: 0, stderr: "" });
  }
  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }
}

export const settled = (output: string): SessionEvent => ({
  type: "settled",
  output,
  stderr: "",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  stopReason: "stop",
  malformedEventCount: 0,
});

export class ControlledRunner implements SessionRunner {
  readonly sessions: ControlledSession[] = [];
  async open(): Promise<ControlledSession> {
    const session = new ControlledSession();
    this.sessions.push(session);
    return session;
  }
  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
```

- [ ] **Step 2: Write failing capacity and initial-generation tests**

Define the complete local fixtures at the top of `test/subagent-manager.test.ts`:

```ts
import { ControlledRunner, settled } from "./helpers/controlled-session.ts";

const profile: AgentProfile = {
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  source: "user",
};
const profiles = new Map([[profile.name, profile]]);
const defaults = { cwd: "/workspace", parentModel: "parent/model", thinkingLevel: "high" as const };
const makeRequests = (count: number): JobRequest[] =>
  Array.from({ length: count }, (_, index) => ({
    task: `Task ${index + 1}`,
    agent: profile.name,
    writeAccess: false,
  }));

const runningManager = async () => {
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  manager.start(makeRequests(1), profiles, defaults);
  await runner.flush();
  return { manager, controlled: runner.sessions[0]! };
};
```

Then add:

```ts
test("opens at most eight sessions and runs at most four generations", async () => {
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  manager.start(makeRequests(8), profiles, defaults);
  await runner.flush();
  assert.equal(runner.sessions.length, 8);
  assert.equal(runner.sessions.filter((session) => session.prompts.length === 1).length, 4);
  assert.throws(() => manager.start(makeRequests(1), profiles, defaults), /eight open/i);
});

test("settlement leaves the child open with one ready result", async () => {
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  manager.start(makeRequests(1), profiles, defaults);
  await runner.flush();
  runner.sessions[0]!.emit(settled("generation one result"));
  await runner.flush();
  assert.equal(manager.get("job-1")?.state, "open");
  assert.equal(manager.get("job-1")?.generations[0]?.state, "completed");
  assert.equal(manager.get("job-1")?.generations[0]?.resultState, "ready");
});
```

- [ ] **Step 3: Run the focused manager test and confirm failure**

Run: `npx tsx --test test/subagent-manager.test.ts`

Expected: FAIL because `SubagentManager` does not exist.

- [ ] **Step 4: Implement the smallest four-slot scheduler**

Use three collections only:

```ts
private readonly sessions = new Map<string, InternalSession>();
private readonly ready: string[] = [];
private readonly active = new Set<string>();
```

`pump()` starts ready sessions FIFO until `active.size === 4`. It never starts a queued follow-up while the previous generation result is `ready`. Settlement removes the active ID, applies the result, notifies subscribers, and pumps once.

- [ ] **Step 5: Add failing generation and result-barrier tests**

Cover:

- one running follow-up is accepted and queued;
- a second queued follow-up is rejected;
- settling generation 1 leaves generation 2 blocked while result 1 is ready;
- collect or discard starts generation 2;
- redirect records one `steer` and leaves the generation number unchanged;
- collect and discard leave the session open;
- close clears the queued follow-up and closes the process.

- [ ] **Step 6: Implement send and control methods directly**

Keep the result barrier explicit:

```ts
private canStartNext(entry: InternalSession): boolean {
  return entry.session.state === "open"
    && !entry.running
    && entry.session.generations.every((generation) => generation.resultState !== "ready");
}
```

Do not add a multi-result collection, priority queue, retry loop, or persistence layer.

- [ ] **Step 7: Add wait and cancellation-settlement tests**

Assert that cancel changes `running -> cancelling`, calls runner abort once, retains the active slot, and changes to `cancelled` only on the normalized settled event. Assert wait returns for terminal or waiting work without collecting or closing.

- [ ] **Step 8: Run the manager tests**

Run: `npx tsx --test test/subagent-manager.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the manager core**

```bash
git add src/subagent-manager.ts test/subagent-manager.test.ts test/helpers/controlled-session.ts
git commit -m "feat: manage persistent subagent generations"
```

---

### Task 5: Add the bounded report inbox and help waiting state

**Files:**

- Modify: `src/subagent-manager.ts`
- Modify: `test/subagent-manager.test.ts`

**Interfaces:**

- Consumes: normalized `report` and `settled` events from `SessionRunner`.
- Produces: `readInbox(id?: string): SubagentReport[]`, `subscribeEvents(listener): () => void`, and manager event types `report_added` and `session_failed`.

- [ ] **Step 1: Write failing progress and help tests**

```ts
test("progress stays in the unread inbox without changing work state", async () => {
  const { manager, controlled } = await runningManager();
  controlled.emit({ type: "report", reportId: "r1", kind: "progress", message: "halfway", timestamp: 10 });
  assert.equal(manager.get("job-1")?.generations[0]?.state, "running");
  assert.deepEqual(manager.readInbox("job-1").map((report) => report.message), ["halfway"]);
  assert.deepEqual(manager.readInbox("job-1"), []);
});

test("help waits only after agent settlement and resumes the same generation", async () => {
  const { manager, controlled } = await runningManager();
  controlled.emit({ type: "report", reportId: "r2", kind: "help_request", message: "Which target?", timestamp: 20 });
  assert.equal(manager.get("job-1")?.generations[0]?.state, "running");
  controlled.emit(settled("Waiting for parent"));
  assert.equal(manager.get("job-1")?.generations[0]?.state, "waiting_for_parent");
  await manager.send("job-1", "Use target A", "follow_up");
  assert.equal(controlled.prompts.at(-1), "Use target A");
  assert.equal(manager.get("job-1")?.generations.at(-1)?.number, 1);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx tsx --test test/subagent-manager.test.ts`

Expected: FAIL because inbox and help transitions are not implemented.

- [ ] **Step 3: Implement a simple byte-bounded inbox**

Use one private append method. Cap each message with `truncateUtf8(message, 4096)`. After append, while total stored bytes exceed 50 KiB, remove the oldest progress report and increment `omittedReports`. Never remove the report named by `pendingHelpReportId`.

Deduplicate by report ID before append. Emit `report_added` once for each accepted report.

- [ ] **Step 4: Implement help settlement without a new subsystem**

Store one private `pendingHelpCandidate` on the internal session when the report arrives. On the next `settled`, change the same generation to `waiting_for_parent`, set `pendingHelpReportId`, and release the active slot. A successful parent prompt clears both fields; a rejected prompt leaves them unchanged.

- [ ] **Step 5: Add inbox overflow and duplicate-report tests**

Assert duplicate IDs inject once, oldest progress is omitted at the byte limit, `omittedReports` increments, and the active help request survives trimming.

- [ ] **Step 6: Run the manager tests**

Run: `npx tsx --test test/subagent-manager.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit reporting**

```bash
git add src/subagent-manager.ts test/subagent-manager.test.ts
git commit -m "feat: add subagent report inbox and help flow"
```

---

### Task 6: Expose send, inbox, generation-aware status, and close tools

**Files:**

- Modify: `src/tools.ts`
- Modify: `test/tools.test.ts`
- Modify: `src/output.ts`
- Modify: `test/json-output.test.ts`

**Interfaces:**

- Consumes: `SubagentManager` public methods and session snapshots.
- Produces: `SendParams`, `InboxParams`, `sendInstruction()`, `readInbox()`, registered tools `subagent_send` and `subagent_inbox`, and control action `close`.

- [ ] **Step 1: Replace the controlled one-shot manager fixture in tool tests**

Import `ControlledRunner` from `test/helpers/controlled-session.ts`. Update `ToolServices.manager` to `SubagentManager`; do not expose test hooks from production modules.

- [ ] **Step 2: Write failing schema and behavior tests**

```ts
test("subagent_send defaults to follow_up and reports generation", async () => {
  const result = await sendInstruction({ id: "job-1", message: "Check tests" }, services);
  assert.match(text(result), /generation 2 queued/i);
});

test("subagent_inbox returns unread reports and marks them read", async () => {
  const first = await readInbox({ id: "job-1" }, services);
  assert.match(text(first), /Which target/);
  assert.match(text(await readInbox({ id: "job-1" }, services)), /No unread reports/);
});

test("collect and close are separate", async () => {
  await controlJobs({ action: "collect", ids: ["job-1"] }, services);
  assert.equal(services.manager.get("job-1")?.state, "open");
  await controlJobs({ action: "close", ids: ["job-1"] }, services);
  assert.equal(services.manager.get("job-1")?.state, "closed");
});
```

Also validate `delivery` as `follow_up | redirect`, reject unknown fields, and reject messages whose UTF-8 bytes exceed 4 KiB even when their character count is smaller.

- [ ] **Step 3: Run the tool tests and confirm failure**

Run: `npx tsx --test test/tools.test.ts test/json-output.test.ts`

Expected: FAIL because the new tools and generation formatter are missing.

- [ ] **Step 4: Add only the two required schemas and handlers**

```ts
const SendParams = Type.Object({
  id: Type.String(),
  message: Type.String({ minLength: 1, maxLength: 4096 }),
  delivery: Type.Optional(StringEnum(["follow_up", "redirect"] as const, { default: "follow_up" })),
}, { additionalProperties: false });

const InboxParams = Type.Object({ id: Type.Optional(Type.String()) }, { additionalProperties: false });
```

Register concise descriptions that state sessions remain open and must be closed explicitly. Do not add batch send, message editing, pagination, or inbox filters.

- [ ] **Step 5: Make collection format exactly one ready generation**

Change `formatCollectedResult()` to accept the session plus generation and include:

```text
# job-1 · generation 2
Session state: open
Work state: completed
## Result
...
```

Keep the combined 50 KiB cap and existing capture notices. After formatting, call manager collect so the queued follow-up can start.

- [ ] **Step 6: Run the focused tool tests**

Run: `npx tsx --test test/tools.test.ts test/json-output.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the tool interface**

```bash
git add src/tools.ts src/output.ts test/tools.test.ts test/json-output.test.ts
git commit -m "feat: expose persistent subagent messaging tools"
```

---

### Task 7: Update status, widget, and dashboard projections

**Files:**

- Modify: `src/job-status.ts`
- Modify: `test/job-status.test.ts`
- Modify: `src/live-widget.ts`
- Modify: `test/live-widget.test.ts`
- Modify: `src/dashboard.ts`
- Modify: `test/dashboard.test.ts`

**Interfaces:**

- Consumes: immutable `SubagentSession` snapshots and the latest generation.
- Produces: bounded public status with `sessionState`, `generation`, `workState`, `queuedFollowUp`, `blockedByResult`, `unreadReports`, `resultReady`, and `pendingHelp`.

- [ ] **Step 1: Write failing status projection tests**

Replace the existing one-shot `job()` fixture with a `SubagentSession` fixture:

```ts
const session = (workState: WorkState, overrides: Partial<SubagentSession> = {}): SubagentSession => ({
  id: "job-1",
  request: { task: "Review the final branch", agent: "reviewer", writeAccess: false },
  profile: { name: "reviewer", description: "Reviews", systemPrompt: "private", source: "user" },
  state: "open",
  createdAt: 1_000,
  generations: [{
    number: 2,
    instruction: "Review the final branch",
    state: workState,
    resultState: workState === "completed" ? "ready" : "none",
    createdAt: 1_000,
    startedAt: 2_000,
    progress: [],
    output: "secret result",
    stderr: "",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    malformedEventCount: 0,
  }],
  reports: [{ id: "help-1", generation: 2, kind: "help_request", message: "Which target?", timestamp: 3_000, read: false }],
  reportBytes: 13,
  omittedReports: 0,
  pendingHelpReportId: "help-1",
  ...overrides,
});

test("status separates session and generation state", () => {
  const status = projectJobStatus(session("waiting_for_parent"), 8_000);
  assert.equal(status.sessionState, "open");
  assert.equal(status.generation, 2);
  assert.equal(status.workState, "waiting_for_parent");
  assert.equal(status.pendingHelp, "Which target?");
});
```

Assert public tool details still exclude profile prompts, full output, stderr, raw errors, and complete inbox contents.

- [ ] **Step 2: Run status tests and confirm failure**

Run: `npx tsx --test test/job-status.test.ts`

Expected: FAIL because status still expects one-shot `Job` state.

- [ ] **Step 3: Update the projection, not the privacy boundary**

Project only bounded values needed by tools and renderers. Keep `STATUS_ACTIVITY_LIMIT = 3`, existing preview bounds, terminal sanitization, launch/reported model separation, and capture notices.

- [ ] **Step 4: Write failing widget tests**

Cover:

Replace the existing `job()` fixture with a concrete session fixture whose third argument overrides the generation:

```ts
const session = (
  id: string,
  workState: WorkState,
  generationOverrides: Partial<Generation> = {},
): SubagentSession => ({
  id,
  request: { task: `Task ${id}`, agent: "reviewer", writeAccess: false },
  profile: { name: "reviewer", description: "Reviews", systemPrompt: "private", source: "user" },
  state: "open",
  createdAt: 1_000,
  generations: [{
    number: 1,
    instruction: `Task ${id}`,
    state: workState,
    resultState: "none",
    createdAt: 1_000,
    startedAt: 2_000,
    finishedAt: ["completed", "cancelled", "failed"].includes(workState) ? 8_000 : undefined,
    progress: [],
    output: "",
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    malformedEventCount: 0,
    ...generationOverrides,
  }],
  reports: [],
  reportBytes: 0,
  omittedReports: 0,
});

const lines = formatLiveWidgetLines([
  session("idle-1", "completed", { resultState: "collected" }),
  session("idle-2", "cancelled", { resultState: "discarded" }),
], options).map(plain);
assert.deepEqual(lines, [
  "○ Subagents",
  "2 idle subagent sessions remain open",
]);
```

Also assert waiting rows remain visible, running rows animate, terminal generations linger for five seconds, and no reasoning text appears.

- [ ] **Step 5: Implement the minimal widget changes**

Render individual rows only for running, queued, waiting, and lingering generations. Append one idle-open summary line for the rest. Do not add generation browsing or new dashboard actions.

- [ ] **Step 6: Update dashboard field reads and copy**

Keep existing navigation, detail modes, scrolling, and cancellation key. Replace one-shot state text with session/generation text and show unread/result/queue counts. Do not add close or message-entry controls to the dashboard in this release.

- [ ] **Step 7: Run focused UI tests**

Run: `npx tsx --test test/job-status.test.ts test/live-widget.test.ts test/dashboard.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit projections and UI**

```bash
git add src/job-status.ts src/live-widget.ts src/dashboard.ts test/job-status.test.ts test/live-widget.test.ts test/dashboard.test.ts
git commit -m "feat: display persistent subagent session state"
```

---

### Task 8: Cut over the extension runtime, guard parent replacement, and remove one-shot code

**Files:**

- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/integration.test.ts`
- Modify: `README.md`
- Remove: `src/process-runner.ts`
- Remove: `src/job-manager.ts`
- Remove: `src/job-lifecycle.ts`
- Remove: `test/process-runner.test.ts`
- Remove: `test/job-manager.test.ts`
- Remove: `test/job-lifecycle.test.ts`

**Interfaces:**

- Consumes: `PiRpcSessionRunner`, `SubagentManager`, manager report events, and Pi session lifecycle hooks.
- Produces: the complete extension runtime with next-turn help injection and safe close-all behavior.

- [ ] **Step 1: Write failing runtime tests for help injection**

Add to `test/tools.test.ts`:

```ts
test("help enters next-turn context once without triggering a turn", async () => {
  const pi = new FakePi();
  const genericProfile: AgentProfile = {
    name: "generic",
    description: "General worker",
    systemPrompt: "",
    source: "builtin",
  };
  const runner = new ControlledRunner();
  const manager = new SubagentManager({ runner });
  createSimpleSubagentsExtension({
    createManager: () => manager,
    loadConfig: async () => ({ config: { confirmWrites: false, allowThinkingOverrides: false } }),
    discoverProfiles: async () => ({ agents: [genericProfile], diagnostics: [] }),
  })(pi as never);
  const ctx = fakeContext({ hasUI: true }, pi);
  await pi.emit("session_start", {}, ctx);
  manager.start([{ task: "inspect", agent: "generic", writeAccess: false }], new Map([["generic", genericProfile]]), { cwd: "/workspace" });
  await runner.flush();
  runner.sessions[0]!.emit({ type: "report", reportId: "help-1", kind: "help_request", message: "Which target?", timestamp: 1 });
  runner.sessions[0]!.emit(settled("Waiting for parent"));
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0].options.deliverAs, "nextTurn");
  assert.equal(pi.messages[0].options.triggerTurn, undefined);
  assert.match(pi.messages[0].message.content, /job-1.*generation 1.*Which target/s);
  assert.deepEqual(pi.notifications, [["job-1 generation 1 needs parent input.", "warning"]]);
});
```

A progress report must produce no parent message.

- [ ] **Step 2: Write failing replacement and shutdown tests**

Cover:

- declining `session_before_switch` returns `{ cancel: true }` and leaves children open;
- confirming waits for `closeAll()` and permits switch;
- `session_before_fork` uses the same guard;
- `session_shutdown` closes all children without prompting;
- repeated shutdown is idempotent.

- [ ] **Step 3: Run runtime tests and confirm failure**

Run: `npx tsx --test test/tools.test.ts`

Expected: FAIL because `src/index.ts` still creates `JobManager` and sends no help messages.

- [ ] **Step 4: Cut over `src/index.ts`**

Construct:

```ts
const manager = dependencies.createManager?.()
  ?? new SubagentManager({ runner: new PiRpcSessionRunner() });
```

On `session_start`, subscribe to manager events. For `report_added` help events, show the bounded warning text `job-N generation G needs parent input.` through `ctx.ui.notify`, then call:

```ts
pi.sendMessage({
  customType: "simple-subagents-help",
  content: `${event.sessionId} generation ${event.generation} needs parent input: ${event.message}`,
  display: true,
}, { deliverAs: "nextTurn" });
```

Do not set `triggerTurn`. For `session_failed`, show one bounded error notification but do not inject a parent-model message.

Use one shared `confirmCloseAll(ctx)` helper for `session_before_switch` and `session_before_fork`. If no interactive confirmation is available, cancel replacement rather than abandoning children. `session_shutdown` calls the same idempotent manager shutdown without a dialog.

- [ ] **Step 5: Remove legacy types and one-shot modules only after imports are gone**

Run first:

```bash
rg -n 'JobManager|PiProcessRunner|JobState|process-runner|job-manager|job-lifecycle' src test
```

Update every remaining production import to the new modules. Keep shared `JobRequest`, profile, usage, progress, launch, and truncation types in `src/types.ts`. Then remove only the six replaced source/test files listed above.

- [ ] **Step 6: Update the opt-in real integration test**

The integration flow must:

1. open one real read-only RPC child;
2. prompt it to read `answer.txt`;
3. wait for generation 1 settlement;
4. collect generation 1;
5. send a follow-up asking it to repeat the same value from context;
6. collect generation 2;
7. close the child;
8. assert the process is closed and no writable tools were enabled.

Run only when credentials are available:

Run: `SIMPLE_SUBAGENTS_INTEGRATION=1 npx tsx --test test/integration.test.ts`

Expected: PASS, or document that it was not run because credentials were unavailable. Never make the normal test suite require external model access.

- [ ] **Step 7: Update README with the exact user workflow**

Document these examples:

```ts
subagent_send({ id: "job-1", message: "Check the failing tests" })
subagent_send({ id: "job-1", message: "Stop and inspect auth first", delivery: "redirect" })
subagent_inbox({ id: "job-1" })
subagent_control({ action: "collect", ids: ["job-1"] })
subagent_control({ action: "close", ids: ["job-1"] })
```

State clearly that collect, discard, and cancel keep sessions open; only close releases them; one queued follow-up and one ready result are allowed; replacement is guarded; reload and exit close all children.

- [ ] **Step 8: Run full verification**

Run:

```bash
npm test
npm run typecheck
git diff --check
```

Then run `lsp_diagnostics` on all changed TypeScript files and `lens_diagnostics({ mode: "all" })`.

Expected: all tests pass, typecheck passes, no blocking diagnostics, and no legacy one-shot imports remain.

- [ ] **Step 9: Commit the runtime cutover**

```bash
git add src test README.md
git commit -m "feat: keep subagent sessions open for follow-up work"
```

---

## Final Review Checklist

- [ ] Every child stays open after terminal work.
- [ ] Four-active and eight-open limits are enforced.
- [ ] There is only one queued follow-up and one uncollected result per session.
- [ ] Redirects stay in the current generation.
- [ ] Help waits after settlement, injects one next-turn parent message, and never starts a turn.
- [ ] Progress remains inbox-only.
- [ ] Cancel, collect, and discard keep the child open.
- [ ] Close cancels active work and closes the process.
- [ ] New/resume/fork/clone cannot abandon children; reload/exit closes them automatically.
- [ ] Output, reports, status, stderr, errors, and malformed records remain bounded and private.
- [ ] Deferred features from suggestion 18 were not implemented.
- [ ] `npm test` and `npm run typecheck` pass.
