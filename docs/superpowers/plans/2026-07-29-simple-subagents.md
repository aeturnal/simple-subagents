# Simple Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lightweight Pi extension that runs cancellable background subagents in isolated JSON-mode subprocesses and exposes completed work through an explicit inbox.

**Architecture:** A session-scoped `JobManager` queues jobs and delegates process execution to a JSON-mode Pi runner. Extension tools and a TUI dashboard observe that manager; only small completion notices enter parent context until a result is collected.

**Tech Stack:** TypeScript, Node.js child processes, Pi extension/TUI APIs 0.82.x, TypeBox, Node's test runner through `tsx`.

## Global Constraints

- One `subagent_start` call accepts at most 8 jobs.
- At most 4 jobs run concurrently, including writable jobs.
- Jobs are memory-only and are cancelled on quit, reload, new session, resume, or fork.
- Generic and user profiles from `~/.pi/agent/agents/*.md` are supported; project profiles are excluded.
- Read-only jobs use `read`, `grep`, `find`, and `ls`; `bash`, `edit`, and `write` require `writeAccess: true`.
- `confirmWrites` defaults to `false`; invalid non-boolean configuration fails safe to `true`.
- Concurrent writers share the working directory without cross-process locks.
- Model-visible collected output is capped at 50 KB per job.
- Use no runtime dependencies beyond Pi peer packages, TypeBox, and Node.js built-ins.

---

## File Structure

- `package.json` — npm/Pi package metadata, scripts, peer and development dependencies.
- `tsconfig.json` — strict TypeScript configuration for source and tests.
- `src/types.ts` — stable domain types and job-state predicates.
- `src/config.ts` — user configuration loading and validation.
- `src/agents.ts` — generic profile and Markdown profile discovery.
- `src/json-stream.ts` — strict LF-delimited event parsing and bounded diagnostics.
- `src/output.ts` — UTF-8-safe byte truncation and collected-result formatting.
- `src/process-runner.ts` — shell-free Pi subprocess lifecycle and event reduction.
- `src/job-manager.ts` — queue, concurrency, state transitions, cancellation, and subscriptions.
- `src/tools.ts` — TypeBox schemas and the three model-facing tools.
- `src/dashboard.ts` — widget formatting and interactive `/subagents` component.
- `src/index.ts` — extension composition, completion notices, UI setup, and shutdown.
- `test/config-agents.test.ts` — configuration and profile tests.
- `test/json-output.test.ts` — stream parsing and truncation tests.
- `test/process-runner.test.ts` — runner tests using injected fake spawn operations.
- `test/job-manager.test.ts` — queue, lifecycle, cancellation, and shutdown tests.
- `test/tools.test.ts` — tool behavior and collection payload tests.
- `test/dashboard.test.ts` — widget and width-safe rendering tests.
- `test/integration.test.ts` — opt-in real Pi subprocess smoke test.
- `README.md` — installation, usage, profile/configuration reference, and safety limitations.

---

### Task 1: Package foundation, domain model, configuration, and profiles

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Create: `src/agents.ts`
- Create: `test/config-agents.test.ts`

**Interfaces:**

- Produces: `JobState`, `Job`, `JobRequest`, `AgentProfile`, `SimpleSubagentsConfig`, `isSettled()`, `loadConfig()`, and `discoverAgents()`.
- Consumes: Pi's `getAgentDir()`, `parseFrontmatter()`, and Node filesystem APIs.

- [ ] **Step 1: Add package and TypeScript configuration**

Create `package.json` with Pi package discovery and deterministic test scripts:

```json
{
  "name": "simple-subagents",
  "version": "0.1.0",
  "description": "Lightweight background subagents for Pi",
  "type": "module",
  "keywords": ["pi-package", "pi", "subagents"],
  "license": "MIT",
  "files": ["src", "README.md"],
  "pi": { "extensions": ["./src/index.ts"] },
  "scripts": {
    "test": "tsx --test test/*.test.ts",
    "test:unit": "tsx --test test/config-agents.test.ts test/json-output.test.ts test/process-runner.test.ts test/job-manager.test.ts test/tools.test.ts test/dashboard.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/node": "^24.0.0",
    "tsx": "^4.20.0",
    "typebox": "*",
    "typescript": "^5.9.0"
  }
}
```

Create `tsconfig.json` using `module` and `moduleResolution` set to `NodeNext`, `target` set to `ES2022`, `strict: true`, `noUncheckedIndexedAccess: true`, and include `src/**/*.ts` plus `test/**/*.ts`.

Run: `npm install`
Expected: dependencies install and `package-lock.json` is created.

- [ ] **Step 2: Write failing configuration and profile tests**

Create tests covering absent configuration, valid/invalid `confirmWrites`, generic profile presence, deterministic duplicate handling, profile parsing, and exclusion of project profiles. Use temporary directories and dependency-injected paths rather than modifying the real home directory.

```typescript
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { discoverAgents } from "../src/agents.ts";

test("invalid confirmWrites fails safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, JSON.stringify({ confirmWrites: "no" }));
  const result = await loadConfig(configPath);
  assert.equal(result.config.confirmWrites, true);
  assert.match(result.warning ?? "", /confirmWrites/);
});

test("discovers generic and user markdown profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  await writeFile(join(agentsDir, "reviewer.md"), `---\nname: reviewer\ndescription: Reviews code\ntools: read, grep\n---\nReturn line-referenced findings.\n`);
  const result = await discoverAgents(agentsDir);
  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "reviewer"]);
  assert.deepEqual(result.agents[1]?.tools, ["read", "grep"]);
});
```

- [ ] **Step 3: Run tests and confirm the missing-module failure**

Run: `npm test -- --test-name-pattern="config|profile|discovers|confirmWrites"`
Expected: FAIL because `src/config.ts` and `src/agents.ts` do not exist.

- [ ] **Step 4: Implement domain types, configuration, and profile discovery**

Define exact domain contracts in `src/types.ts`:

```typescript
export interface SimpleSubagentsConfig {
  confirmWrites: boolean;
}

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "collected" | "discarded";
export type AccessMode = "read-only" | "write";

export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  source: "builtin" | "user";
  filePath?: string;
}

export interface JobRequest {
  task: string;
  agent: string;
  writeAccess: boolean;
  cwd?: string;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ProgressItem {
  type: "text" | "tool" | "diagnostic";
  text: string;
  timestamp: number;
}

export interface Job {
  id: string;
  request: JobRequest;
  profile: AgentProfile;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: ProgressItem[];
  output: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  malformedEventCount: number;
  truncation?: { originalBytes: number; keptBytes: number };
}

export const isSettled = (state: JobState): boolean =>
  state === "completed" || state === "failed" || state === "cancelled" || state === "collected" || state === "discarded";
```

Implement `loadConfig(configPath)` returning `{ config: { confirmWrites: boolean }, warning?: string }`. Missing files return `false`; invalid JSON warns and returns `true`; a non-boolean `confirmWrites` warns and returns `true`.

Implement `discoverAgents(agentsDir)` asynchronously. Always place a built-in `generic` profile first, sort filenames lexically, parse only regular or symlinked `.md` files, require non-empty `name` and `description`, split comma-separated tools, and keep the first duplicate. Return `{ agents, diagnostics }`.

- [ ] **Step 5: Run unit tests and typecheck**

Run: `npm run test:unit -- --test-name-pattern="config|profile|discovers|confirmWrites" && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the package foundation**

```bash
git add package.json package-lock.json tsconfig.json src/types.ts src/config.ts src/agents.ts test/config-agents.test.ts
git commit -m "feat: add configuration and agent discovery"
```

---

### Task 2: JSON event parsing and bounded output

**Files:**

- Create: `src/json-stream.ts`
- Create: `src/output.ts`
- Create: `test/json-output.test.ts`

**Interfaces:**

- Produces: `JsonLineParser.push(chunk)`, `JsonLineParser.finish()`, `truncateUtf8(text, maxBytes)`, and `formatCollectedResult(job)`.
- Consumes: `Job` from `src/types.ts`.

- [ ] **Step 1: Write failing parser and UTF-8 truncation tests**

Test LF framing across chunk boundaries, optional trailing CR, malformed-line accounting, final unterminated records, and multibyte truncation:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { JsonLineParser } from "../src/json-stream.ts";
import { truncateUtf8 } from "../src/output.ts";

test("parses JSON records split across chunks", () => {
  const parser = new JsonLineParser();
  assert.deepEqual(parser.push(Buffer.from('{"type":"message_')), []);
  assert.deepEqual(parser.push(Buffer.from('end"}\r\n')), [{ type: "message_end" }]);
  assert.deepEqual(parser.finish(), []);
});

test("truncates without splitting UTF-8 characters", () => {
  const result = truncateUtf8("a😀b", 5);
  assert.equal(result.text, "a😀");
  assert.deepEqual(result.truncation, { originalBytes: 6, keptBytes: 5 });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `tsx --test test/json-output.test.ts`
Expected: FAIL because parser and output modules do not exist.

- [ ] **Step 3: Implement strict JSONL parsing**

`JsonLineParser` must use `StringDecoder("utf8")`, split only on `\n`, strip one trailing `\r`, ignore blank lines, and return parsed `unknown[]`. Expose bounded diagnostics through readonly `malformedCount` and `malformedSamples`, retaining at most three samples of 500 characters each.

- [ ] **Step 4: Implement output truncation and collection formatting**

Implement byte-safe truncation by reducing a `Buffer` boundary until `buffer.subarray(0, end).toString("utf8")` round-trips to the same byte length. Set `COLLECTED_OUTPUT_MAX_BYTES = 50 * 1024`.

`formatCollectedResult(job)` must produce this stable shape:

```text
# Subagent result: job-42

- Status: completed
- Agent: reviewer
- Access: read-only
- Task: Review token handling

## Result

Final findings
```

For failed or cancelled jobs, include `## Diagnostics` with output and stderr. Append a truncation notice containing original and retained byte counts when needed.

- [ ] **Step 5: Run tests and typecheck**

Run: `tsx --test test/json-output.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit parsing and output utilities**

```bash
git add src/json-stream.ts src/output.ts test/json-output.test.ts
git commit -m "feat: parse subagent events and bound output"
```

---

### Task 3: Isolated Pi subprocess runner

**Files:**

- Create: `src/process-runner.ts`
- Create: `test/process-runner.test.ts`

**Interfaces:**

- Consumes: `AgentProfile`, `JobRequest`, and `UsageStats` from `src/types.ts`; `JsonLineParser` from `src/json-stream.ts`.
- Produces: `PiProcessRunner`, the `ProcessRunner` interface, and `RunningProcess`.

```typescript
export interface ProcessRunOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  parentModel?: string;
  thinkingLevel?: string;
  onProgress(item: ProgressItem): void;
}

export interface ProcessResult {
  exitCode: number;
  output: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  malformedEventCount: number;
}

export interface RunningProcess {
  result: Promise<ProcessResult>;
  cancel(): Promise<void>;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): RunningProcess;
}

export class PiProcessRunner implements ProcessRunner {
  run(options: ProcessRunOptions): RunningProcess;
}
```

- [ ] **Step 1: Write failing argument, event-reduction, and cancellation tests**

Inject a `spawnProcess(command, args, options)` dependency returning a fake child with stdout/stderr event emitters, `kill(signal)`, and a close event. Assert that:

- No shell is used.
- Arguments include `--mode json`, `-p`, `--no-session`, resolved model/thinking, and permitted tools.
- Read-only requests omit `bash`, `edit`, and `write` even if a profile requests them.
- Writable requests permit requested `bash`, `edit`, and `write`.
- `message_end` assistant events update output and usage.
- `tool_execution_start` emits progress.
- Cancellation sends `SIGTERM`, then `SIGKILL` after the injected five-second timer.

- [ ] **Step 2: Run runner tests and verify failure**

Run: `tsx --test test/process-runner.test.ts`
Expected: FAIL because `ProcessRunner` is missing.

- [ ] **Step 3: Implement invocation and temporary prompt handling**

Resolve the Pi executable using the same strategy as Pi's bundled subagent example: prefer the current Pi script via `process.execPath`, otherwise invoke `pi`. Build arguments without a shell. Pass inherited model and thinking as `--model provider/id:thinking`; preserve an explicit thinking suffix already present in a profile model. Write a non-empty profile system prompt to a mode-`0600` temporary file and pass `--append-system-prompt <path>`.

Use these permission sets:

```typescript
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
```

The generic profile gets every tool in its access set. Named profiles get only requested tools intersected with that set.

- [ ] **Step 4: Implement event reduction and cleanup**

Parse stdout with `JsonLineParser`. Handle documented `message_end`, `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events plus the bundled example's `tool_result_end` compatibility event. Accumulate assistant usage, keep the latest assistant text as final output, append bounded progress items, and capture stderr.

On close, flush the parser, settle exactly once, remove listeners, clear escalation timers, and remove temporary prompt files. On spawn error, resolve a failed `ProcessResult` rather than leaving the promise pending.

- [ ] **Step 5: Run runner tests and typecheck**

Run: `tsx --test test/process-runner.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the subprocess runner**

```bash
git add src/process-runner.ts test/process-runner.test.ts
git commit -m "feat: run isolated Pi subagents"
```

---

### Task 4: Background job manager and cancellation

**Files:**

- Create: `src/job-manager.ts`
- Create: `test/job-manager.test.ts`

**Interfaces:**

- Consumes: `ProcessRunner`, `ProcessResult`, `Job`, `JobRequest`, and `AgentProfile`.
- Produces:

```typescript
export class JobManager {
  constructor(options: { runner: ProcessRunner; concurrency?: number; now?: () => number });
  enqueue(requests: JobRequest[], profiles: ReadonlyMap<string, AgentProfile>, defaults: { cwd: string; parentModel?: string; thinkingLevel?: string }): Job[];
  list(): readonly Job[];
  get(id: string): Job | undefined;
  cancel(id: string): Promise<Job>;
  collect(id: string): Job;
  discard(id: string): Job;
  subscribe(listener: (jobs: readonly Job[]) => void): () => void;
  shutdown(): Promise<void>;
}
```

- [ ] **Step 1: Write failing queue and state-machine tests**

Use a local `ControlledRunner implements ProcessRunner` whose `run()` method records options and returns manually controlled deferred result promises. Add local `makeRequests(count)` and `successfulResult(output)` helpers returning fully populated `JobRequest[]` and `ProcessResult` values. Cover:

- Maximum four active runs.
- FIFO start when a slot opens.
- Rejection of empty batches and batches over eight.
- Unknown profiles rejected before queue mutation.
- Stable increasing IDs.
- Progress subscription updates.
- Completion, failure, and cancellation states.
- Idempotent cancellation.
- Collection only from completed, failed, or cancelled states.
- Discard only from settled inbox states.
- Shutdown cancellation of queued and active jobs.

```typescript
test("starts queued work when a slot opens", async () => {
  const fake = new ControlledRunner();
  const manager = new JobManager({ runner: fake, concurrency: 2, now: () => 100 });
  manager.enqueue(makeRequests(3), profiles, defaults);
  assert.equal(fake.started.length, 2);
  fake.complete(0, successfulResult("one"));
  await fake.flush();
  assert.equal(fake.started.length, 3);
});
```

- [ ] **Step 2: Run manager tests and verify failure**

Run: `tsx --test test/job-manager.test.ts`
Expected: FAIL because `JobManager` does not exist.

- [ ] **Step 3: Implement queueing and immutable notifications**

Store mutable internal jobs but return cloned public snapshots from `list()`, `get()`, and subscribers. Allocate IDs as `job-${counter}`. Validate the complete batch before enqueueing any item. Call a private `pump()` after enqueue and every terminal transition.

Keep `Map<string, RunningProcess>` for active processes. Progress callbacks append to a bounded history of 200 items and notify subscribers.

- [ ] **Step 4: Implement terminal operations and shutdown**

Map process results as follows:

- Exit `0` with non-error stop reason and non-empty output: `completed`.
- Non-zero exit, `stopReason === "error"`, or missing output: `failed`.
- Explicit manager cancellation: `cancelled` regardless of the later close code.

`cancel()` marks queued jobs immediately; running jobs await `RunningProcess.cancel()`. `collect()` moves inbox states to `collected`; `discard()` moves them to `discarded`. `shutdown()` stops pumping, marks queued jobs cancelled, cancels every active process concurrently, and waits for settlement.

- [ ] **Step 5: Run manager tests and typecheck**

Run: `tsx --test test/job-manager.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the job manager**

```bash
git add src/job-manager.ts test/job-manager.test.ts
git commit -m "feat: manage background subagent jobs"
```

---

### Task 5: Model tools, collection, and completion notices

**Files:**

- Create: `src/tools.ts`
- Create: `src/index.ts`
- Create: `test/tools.test.ts`

**Interfaces:**

- Consumes: `JobManager`, `discoverAgents()`, `loadConfig()`, and `formatCollectedResult()`.
- Produces: default Pi extension factory and `registerSubagentTools(pi, services)`.

- [ ] **Step 1: Write failing tool-service tests**

Extract plain service functions behind tool execution so tests do not need a complete Pi runtime:

```typescript
export interface ToolServices {
  manager: JobManager;
  getProfiles(): Promise<ReadonlyMap<string, AgentProfile>>;
  confirmWritable(requests: readonly JobRequest[], ctx: ExtensionContext): Promise<boolean>;
  defaults(ctx: ExtensionContext): { cwd: string; parentModel?: string; thinkingLevel?: string };
}
```

Test exact behavior for:

- Starting one or multiple jobs.
- Maximum batch validation.
- Default agent `generic` and `writeAccess: false`.
- Confirmation only when configuration enables it.
- Status list and single-job inspection.
- Cancel, collect, and discard actions.
- Collection returning `formatCollectedResult(job)`.
- Unknown job diagnostics.

- [ ] **Step 2: Run tool tests and verify failure**

Run: `tsx --test test/tools.test.ts`
Expected: FAIL because tool registration and services are missing.

- [ ] **Step 3: Define strict TypeBox schemas and register tools**

Use `StringEnum` for Google-compatible actions. Define:

```typescript
const StartTask = Type.Object({
  task: Type.String({ minLength: 1 }),
  agent: Type.Optional(Type.String({ default: "generic" })),
  writeAccess: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String())
});

const StartParams = Type.Object({
  tasks: Type.Array(StartTask, { minItems: 1, maxItems: 8 })
});

const StatusParams = Type.Object({ id: Type.Optional(Type.String()) });
const ControlParams = Type.Object({
  action: StringEnum(["cancel", "collect", "discard"] as const),
  ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8 })
});
```

Tool descriptions must state that tasks are self-contained, jobs are read-only unless writes are needed, collected output alone enters context, and concurrent writable jobs should receive non-overlapping work.

Return compact text plus structured details. Ordinary job failures remain successful tool executions with job state in details; throw only for extension-level failures.

- [ ] **Step 4: Compose the extension and completion notifier**

In `src/index.ts`, create one manager per extension runtime. On `session_start`, load configuration and profiles, set up UI state, and display configuration warnings.

Subscribe to manager snapshots. Detect newly transitioned `completed`, `failed`, and `cancelled` jobs. Debounce for 100 milliseconds and send one lightweight message listing ready IDs:

```typescript
pi.sendMessage({
  customType: "simple-subagents-ready",
  content: `${summary}\nAsk the user whether and when they want to collect these results.`,
  display: true,
  details: { jobIds }
}, { deliverAs: "followUp", triggerTurn: true });
```

Do not include final output in this notice. Track notified IDs so rerenders do not resend notices.

When `confirmWrites` is true, use `ctx.ui.confirm()` once for the writable jobs in the requested batch. Reject when `ctx.hasUI` is false.

- [ ] **Step 5: Add compact custom renderers**

Register a message renderer for `simple-subagents-ready`. Tool renderers show start count, job IDs, status icons, and collection summaries using `Text`, with detailed content only when expanded.

- [ ] **Step 6: Run tool tests and all unit tests**

Run: `tsx --test test/tools.test.ts && npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit tools and extension composition**

```bash
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "feat: expose background subagent tools"
```

---

### Task 6: Compact widget and interactive dashboard

**Files:**

- Create: `src/dashboard.ts`
- Create: `test/dashboard.test.ts`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: readonly `Job[]`, `JobManager`, Pi `Theme`, and TUI key input.
- Produces: `formatWidgetLines(jobs, theme)`, `SubagentsDashboard`, and `registerSubagentsUi(pi, manager)`.

- [ ] **Step 1: Write failing widget and dashboard tests**

Cover:

- Widget hidden when no queued, running, completed, failed, or cancelled jobs need attention.
- Correct queued/running/ready counts.
- Collected and discarded jobs excluded from attention counts.
- Every rendered line has `visibleWidth(line) <= width` at widths 30, 60, and 100.
- Up/down selection stays in range.
- `c` cancels queued/running jobs.
- `x` collects settled inbox jobs.
- `d` discards settled inbox jobs.
- Enter toggles detail mode; Escape closes.
- Subscription updates invalidate cached rendering and request a TUI render.

- [ ] **Step 2: Run dashboard tests and verify failure**

Run: `tsx --test test/dashboard.test.ts`
Expected: FAIL because dashboard exports do not exist.

- [ ] **Step 3: Implement the conditional widget**

Use `ctx.ui.setWidget("simple-subagents", factory)` only when attention count is non-zero; clear it otherwise. Render one line:

```text
● Subagents · 2 running · 1 ready
```

Use theme callbacks at render time and `truncateToWidth()` for the final line. Treat completed, failed, and cancelled jobs as ready until collected or discarded.

- [ ] **Step 4: Implement the dashboard component**

Implement `Component` with cached `render(width)`, `handleInput(data)`, and `invalidate()`. Group rows into `QUEUED`, `RUNNING`, and `INBOX`. Show a write marker `W` for writable jobs, elapsed time for active jobs, compact task text, and help text:

```text
↑↓ navigate · enter inspect · c cancel · x collect · d discard · esc close
```

Detailed mode shows task, profile, access, timestamps, recent progress, output, stderr, usage, and truncation information. Use `matchesKey()` and `truncateToWidth()`; wrap long detailed content with `wrapTextWithAnsi()`.

Dashboard collection must call `manager.collect(id)` and then inject `formatCollectedResult(job)` through `pi.sendMessage()` as a displayed `simple-subagents-result` custom message with `deliverAs: "nextTurn"`. Register a Markdown renderer for that custom message.

- [ ] **Step 5: Register `/subagents` and live subscriptions**

Guard with `ctx.mode === "tui"`; otherwise notify that the dashboard requires interactive mode. Build the custom component through `ctx.ui.custom()`. Subscribe while it is open, call `tui.requestRender()` on updates, and unsubscribe when `done()` closes the component.

On every manager update, refresh or clear the compact widget. On `session_shutdown`, clear the widget before manager shutdown.

- [ ] **Step 6: Run dashboard and regression tests**

Run: `tsx --test test/dashboard.test.ts && npm run test:unit && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the Pi UI**

```bash
git add src/dashboard.ts src/index.ts test/dashboard.test.ts
git commit -m "feat: add subagent inbox dashboard"
```

---

### Task 7: Integration verification and package documentation

**Files:**

- Create: `test/integration.test.ts`
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: public extension package and `ProcessRunner`.
- Produces: documented installable Pi package with opt-in real-process verification.

- [ ] **Step 1: Write the opt-in integration test**

Gate the test on `SIMPLE_SUBAGENTS_INTEGRATION=1`. Without the variable, use `test.skip`. With it, run the generic read-only agent in a temporary directory containing `answer.txt`, prompt it to read the file and return its exact content, and assert exit code `0`, non-empty output, and no write tools in the invocation.

Give the test a 120-second timeout and always cancel the runner in `t.after()` if it has not settled.

- [ ] **Step 2: Run the normal suite and verify integration skips cleanly**

Run: `npm test`
Expected: unit/component tests PASS and the real-process integration test is SKIP.

- [ ] **Step 3: Write the README**

Document:

- `pi install .` and `pi -e ./src/index.ts` local usage.
- Natural-language examples for parallel start, status, cancellation, and collection.
- `/subagents` controls.
- Generic behavior and `~/.pi/agent/agents/*.md` profile format.
- `~/.pi/agent/simple-subagents.json` with `confirmWrites` defaulting to false.
- Four-job concurrency and eight-job batch limits.
- Read-only defaults and automatic write access requested by the parent model.
- Shared-workspace concurrent-write conflict warning.
- 50 KB collection limit.
- Cancellation and shutdown behavior.
- Memory-only inbox and loss of uncollected results on reload/session replacement/exit.

- [ ] **Step 4: Add package metadata checks**

Add `engines: { "node": ">=20" }`, `repository` only if a real repository URL is known, and an `exports` entry for `./src/index.ts`. Do not invent a repository URL.

Run: `npm pack --dry-run`
Expected: tarball contains `package.json`, `README.md`, and `src/**`, and excludes tests, docs, `.superpowers`, and development output.

- [ ] **Step 5: Run proactive diagnostics and full verification**

Run in this order:

```bash
npm run typecheck
npm run test:unit
npm test
npm pack --dry-run
git diff --check
git status --short
```

Expected: typecheck and tests PASS, integration SKIP unless opted in, package contents are correct, no whitespace errors, and only intended files are modified.

Then run `lsp_diagnostics` on `src/` and `test/`, followed by `lens_diagnostics mode=all`; resolve every blocking diagnostic before committing.

- [ ] **Step 6: Optionally run the credentialed real-process smoke test**

Run: `SIMPLE_SUBAGENTS_INTEGRATION=1 npm test -- --test-name-pattern="real Pi"`
Expected: PASS when a configured Pi model is available. If credentials or network are unavailable, record the exact external limitation without weakening the test.

- [ ] **Step 7: Commit documentation and integration coverage**

```bash
git add README.md package.json test/integration.test.ts
git commit -m "docs: document simple-subagents package"
```

- [ ] **Step 8: Review commit history and final state**

Run: `git log --oneline --decorate -8 && git status --short --branch`
Expected: focused commits for discovery, parsing, runner, manager, tools, dashboard, and documentation; working tree clean.
