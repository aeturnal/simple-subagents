import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import {
  ControlParams,
  StartParams,
  StatusParams,
  controlJobs,
  registerSubagentTools,
  startJobs,
  statusJobs,
  type ToolServices,
} from "../src/tools.ts";
import {
  createSimpleSubagentsExtension,
  installCompletionNotifier,
  type ExtensionDependencies,
} from "../src/index.js";
import { JobManager } from "../src/job-manager.js";
import type { ProcessResult, ProcessRunOptions, ProcessRunner, RunningProcess } from "../src/process-runner.js";
import type { AgentProfile, Job, UsageStats } from "../src/types.js";

const usage = (): UsageStats => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 });
const profile: AgentProfile = {
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  source: "user",
};

const completed = (output = "finished output"): ProcessResult => ({
  exitCode: 0,
  output,
  stderr: "",
  usage: usage(),
  malformedEventCount: 0,
});

class ControlledRunner implements ProcessRunner {
  readonly started: Array<{ options: ProcessRunOptions; resolve: (result: ProcessResult) => void; cancelled: number }> = [];

  run(options: ProcessRunOptions): RunningProcess {
    let resolve!: (result: ProcessResult) => void;
    const result = new Promise<ProcessResult>((nextResolve) => {
      resolve = nextResolve;
    });
    const started = { options, resolve, cancelled: 0 };
    this.started.push(started);
    return { result, cancel: async () => { started.cancelled += 1; } };
  }

  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const text = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]?.text ?? "";

const createServices = (runner = new ControlledRunner(), overrides: Partial<ToolServices> = {}): { services: ToolServices; runner: ControlledRunner } => {
  const manager = new JobManager({ runner });
  const services: ToolServices = {
    manager,
    getProfiles: async () => new Map([["generic", { ...profile, name: "generic", source: "builtin" as const }], [profile.name, profile]]),
    confirmWritable: async () => true,
    defaults: () => ({ cwd: "/workspace", parentModel: "parent/model", thinkingLevel: "high" }),
    ...overrides,
  };
  return { services, runner };
};

test("startJobs applies generic read-only defaults and reports every created ID", async () => {
  const { services, runner } = createServices();

  const result = await startJobs({ tasks: [{ task: "inspect this" }, { task: "review this", agent: "reviewer", cwd: "/other" }] }, services, {} as never);

  assert.match(text(result), /Started 2 jobs/);
  assert.deepEqual(result.details.jobs.map((job) => job.id), ["job-1", "job-2"]);
  assert.deepEqual(runner.started.map((entry) => entry.options.request), [
    { task: "inspect this", agent: "generic", writeAccess: false, cwd: undefined },
    { task: "review this", agent: "reviewer", writeAccess: false, cwd: "/other" },
  ]);
});

test("startJobs validates an over-eight batch without starting any jobs", async () => {
  const { services, runner } = createServices();
  const result = await startJobs({ tasks: Array.from({ length: 9 }, (_, index) => ({ task: `task ${index}` })) }, services, {} as never);

  assert.match(text(result), /at most 8/i);
  assert.deepEqual(result.details.jobs, []);
  assert.equal(runner.started.length, 0);
});

test("startJobs asks once only for a writable batch and respects rejection", async () => {
  let confirmations = 0;
  const { services, runner } = createServices(undefined, {
    confirmWritable: async (requests) => {
      confirmations += 1;
      assert.deepEqual(requests.map((request) => request.task), ["write one", "write two"]);
      return false;
    },
  });

  const readOnly = await startJobs({ tasks: [{ task: "read" }] }, services, {} as never);
  const rejected = await startJobs({ tasks: [{ task: "write one", writeAccess: true }, { task: "write two", writeAccess: true }] }, services, {} as never);

  assert.match(text(readOnly), /Started 1 job/);
  assert.match(text(rejected), /not approved/i);
  assert.equal(confirmations, 1);
  assert.equal(runner.started.length, 1);
});

test("statusJobs lists all jobs and can inspect one job", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "one" }, { task: "two" }] }, services, {} as never);
  runner.started[0]?.resolve(completed());
  await runner.flush();

  const listed = await statusJobs({}, services);
  const inspected = await statusJobs({ id: "job-1" }, services);

  assert.equal(listed.details.jobs.length, 2);
  assert.equal(inspected.details.jobs.length, 1);
  assert.equal(inspected.details.jobs[0]?.state, "completed");
});

test("statusJobs returns an ordinary diagnostic for an unknown ID", async () => {
  const { services } = createServices();
  const result = await statusJobs({ id: "missing" }, services);

  assert.match(text(result), /Unknown job: missing/);
  assert.deepEqual(result.details.jobs, []);
  assert.deepEqual(result.details.diagnostics, ["Unknown job: missing"]);
});

test("controlJobs handles multi-ID cancellation and leaves unknown IDs as diagnostics", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "one" }, { task: "two" }] }, services, {} as never);

  const result = await controlJobs({ action: "cancel", ids: ["job-1", "missing", "job-2"] }, services);

  assert.deepEqual(result.details.jobs.map((job) => [job.id, job.state]), [["job-1", "cancelled"], ["job-2", "cancelled"]]);
  assert.deepEqual(result.details.diagnostics, ["Unknown job: missing"]);
  assert.equal(runner.started[0]?.cancelled, 1);
  assert.equal(runner.started[1]?.cancelled, 1);
});

test("controlJobs formats the terminal snapshot before collecting it", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "find the answer" }] }, services, {} as never);
  runner.started[0]?.resolve(completed("secret final answer"));
  await runner.flush();

  const result = await controlJobs({ action: "collect", ids: ["job-1"] }, services);

  assert.match(text(result), /# Subagent result: job-1/);
  assert.match(text(result), /Status: completed/);
  assert.match(text(result), /secret final answer/);
  assert.equal(result.details.jobs[0]?.state, "collected");
  assert.equal(services.manager.get("job-1")?.state, "collected");
});

test("controlJobs reports invalid transitions while continuing other IDs", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "running" }, { task: "settled" }] }, services, {} as never);
  runner.started[1]?.resolve(completed());
  await runner.flush();

  const result = await controlJobs({ action: "collect", ids: ["job-1", "job-2", "missing"] }, services);

  assert.equal(result.details.jobs[0]?.id, "job-2");
  assert.equal(result.details.jobs[0]?.state, "collected");
  assert.equal(result.details.diagnostics.length, 2);
  assert.match(result.details.diagnostics[0] ?? "", /Cannot collect/i);
  assert.match(result.details.diagnostics[1] ?? "", /Unknown job/i);
});

test("controlJobs discards completed jobs without placing output into model content", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "discard" }] }, services, {} as never);
  runner.started[0]?.resolve(completed("do not surface this"));
  await runner.flush();

  const result = await controlJobs({ action: "discard", ids: ["job-1"] }, services);

  assert.equal(result.details.jobs[0]?.state, "discarded");
  assert.doesNotMatch(text(result), /do not surface this/);
});

test("registered tools expose strict schema boundaries and required guidance", () => {
  const pi = new FakePi();
  const { services } = createServices();
  registerSubagentTools(pi as never, services);

  const startSchema = StartParams as unknown as { properties: { tasks: { minItems: number; maxItems: number; items: { properties: { task: { minLength: number }; agent: { default: string }; writeAccess: { default: boolean } } } } } };
  const statusSchema = StatusParams as unknown as { properties: { id: { type: string } } };
  const controlSchema = ControlParams as unknown as { properties: { action: { enum: string[] }; ids: { minItems: number; maxItems: number } } };
  assert.equal(startSchema.properties.tasks.minItems, 1);
  assert.equal(startSchema.properties.tasks.maxItems, 8);
  assert.equal(startSchema.properties.tasks.items.properties.task.minLength, 1);
  assert.equal(startSchema.properties.tasks.items.properties.agent.default, "generic");
  assert.equal(startSchema.properties.tasks.items.properties.writeAccess.default, false);
  assert.equal(statusSchema.properties.id.type, "string");
  assert.deepEqual(controlSchema.properties.action.enum, ["cancel", "collect", "discard"]);
  assert.equal(controlSchema.properties.ids.minItems, 1);
  assert.equal(controlSchema.properties.ids.maxItems, 8);

  for (const name of ["subagent_start", "subagent_status", "subagent_control"]) {
    const description = pi.tools.get(name)?.description ?? "";
    assert.match(description, /self-contained/i);
    assert.match(description, /read-only/i);
    assert.match(description, /collected.*context/i);
    assert.match(description, /non-overlapping/i);
  }
});

test("completion notices debounce newly ready IDs, deduplicate rerenders, and never leak output", () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  let listener: ((jobs: readonly Job[]) => void) | undefined;
  const manager = {
    subscribe(next: (jobs: readonly Job[]) => void) {
      listener = next;
      return () => { listener = undefined; };
    },
  } as unknown as JobManager;
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  const ready = (id: string, state: Job["state"], output: string): Job => ({
    id,
    state,
    request: { task: output, agent: "generic", writeAccess: false },
    profile: { ...profile, name: "generic", source: "builtin" },
    createdAt: 1,
    progress: [],
    output,
    stderr: output,
    usage: usage(),
    malformedEventCount: 0,
  });

  listener?.([ready("job-1", "running", "first secret")]);
  listener?.([ready("job-1", "completed", "first secret"), ready("job-2", "failed", "second secret")]);
  listener?.([ready("job-1", "completed", "first secret"), ready("job-2", "failed", "second secret")]);
  assert.equal(timers.pending.length, 1);
  timers.runAll();

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0]?.details, { jobIds: ["job-1", "job-2"] });
  assert.match(pi.messages[0]?.content ?? "", /job-1.*completed/i);
  assert.match(pi.messages[0]?.content ?? "", /job-2.*failed/i);
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /secret/);
  assert.deepEqual(pi.messageOptions[0], { deliverAs: "followUp", triggerTurn: true });

  listener?.([ready("job-1", "completed", "first secret"), ready("job-2", "failed", "second secret")]);
  assert.equal(timers.pending.length, 0);
  cleanup();
});

test("completion notifier cleanup clears a pending timer and unsubscribes", () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  let listener: ((jobs: readonly Job[]) => void) | undefined;
  const manager = { subscribe(next: (jobs: readonly Job[]) => void) { listener = next; return () => { listener = undefined; }; } } as unknown as JobManager;
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  listener?.([{ id: "job-1", state: "cancelled" } as Job]);

  cleanup();
  timers.runAll();

  assert.equal(pi.messages.length, 0);
  assert.equal(listener, undefined);
});

test("runtime loads config and profiles, surfaces diagnostics, confirms writable starts once, and shuts down cleanly", async () => {
  const pi = new FakePi();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const dependencies: ExtensionDependencies = {
    createManager: () => manager,
    loadConfig: async (path) => {
      assert.equal(path, join("/workspace", ".pi", "simple-subagents.json"));
      return { config: { confirmWrites: true }, warning: "config warning" };
    },
    discoverProfiles: async () => ({ agents: [{ ...profile, name: "writer" }], diagnostics: ["profile warning"] }),
    setTimer: () => 1,
    clearTimer: () => {},
  };
  createSimpleSubagentsExtension(dependencies)(pi as never);
  await pi.emit("session_start", {}, fakeContext({ hasUI: true }, pi));

  assert.deepEqual(pi.notifications, [["config warning", "warning"], ["profile warning", "warning"]]);
  const start = pi.tools.get("subagent_start");
  assert.ok(start);
  const result = await start.execute("call", { tasks: [{ task: "write", agent: "writer", writeAccess: true }, { task: "also write", agent: "writer", writeAccess: true }] }, undefined, undefined, fakeContext({ hasUI: true }, pi));
  assert.equal(pi.confirmations.length, 1);
  assert.match(text(result), /Started 2 jobs/);

  const shuttingDown = pi.emit("session_shutdown", {}, fakeContext({ hasUI: true }, pi));
  assert.equal(runner.started[0]?.cancelled, 1);
  for (const started of runner.started) started.resolve(completed());
  await shuttingDown;
  await pi.emit("session_shutdown", {}, fakeContext({ hasUI: true }, pi));
});

test("runtime starts writable jobs without confirmation when configuration disables it", async () => {
  const pi = new FakePi();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  createSimpleSubagentsExtension({
    createManager: () => manager,
    loadConfig: async () => ({ config: { confirmWrites: false } }),
    discoverProfiles: async () => ({ agents: [{ ...profile, name: "writer" }], diagnostics: [] }),
  })(pi as never);
  await pi.emit("session_start", {}, fakeContext({ hasUI: false }, pi));

  const start = pi.tools.get("subagent_start");
  assert.ok(start);
  const result = await start.execute("call", { tasks: [{ task: "write", agent: "writer", writeAccess: true }] }, undefined, undefined, fakeContext({ hasUI: false }, pi));

  assert.match(text(result), /Started 1 job/);
  assert.deepEqual(pi.confirmations, []);
  const stopping = pi.emit("session_shutdown", {}, fakeContext({ hasUI: false }, pi));
  runner.started[0]?.resolve(completed());
  await stopping;
});

test("runtime rejects writable starts without UI when confirmation is configured and registers renderers", async () => {
  const pi = new FakePi();
  const manager = new JobManager({ runner: new ControlledRunner() });
  createSimpleSubagentsExtension({
    createManager: () => manager,
    loadConfig: async () => ({ config: { confirmWrites: true } }),
    discoverProfiles: async () => ({ agents: [{ ...profile, name: "writer" }], diagnostics: [] }),
  })(pi as never);
  await pi.emit("session_start", {}, fakeContext({ hasUI: false }, pi));

  const start = pi.tools.get("subagent_start");
  assert.ok(start);
  const result = await start.execute("call", { tasks: [{ task: "write", agent: "writer", writeAccess: true }] }, undefined, undefined, fakeContext({ hasUI: false }, pi));

  assert.match(text(result), /not approved/i);
  assert.equal(manager.list().length, 0);
  assert.equal(pi.messageRenderers.has("simple-subagents-ready"), true);
  assert.ok(pi.tools.get("subagent_start")?.renderCall);
  assert.ok(pi.tools.get("subagent_start")?.renderResult);
});

class FakeTimers {
  pending: Array<() => void> = [];
  setTimer = (callback: () => void, _delay: number): number => {
    this.pending.push(callback);
    return this.pending.length;
  };
  clearTimer = (timer: number): void => {
    this.pending.splice(timer - 1, 1);
  };
  runAll(): void {
    const pending = this.pending.splice(0);
    for (const callback of pending) callback();
  }
}

class FakePi {
  readonly tools = new Map<string, any>();
  readonly handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  readonly messages: Array<{ customType: string; content: string; display: boolean; details: unknown }> = [];
  readonly messageOptions: unknown[] = [];
  readonly notifications: Array<[string, string]> = [];
  readonly confirmations: Array<[string, string]> = [];
  readonly messageRenderers = new Map<string, unknown>();

  registerTool(tool: any): void { this.tools.set(tool.name, tool); }
  on(event: string, handler: (event: unknown, ctx: any) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options: unknown): void {
    this.messages.push(message);
    this.messageOptions.push(options);
  }
  registerMessageRenderer(type: string, renderer: unknown): void { this.messageRenderers.set(type, renderer); }
}

const fakeContext = ({ hasUI }: { hasUI: boolean }, pi: FakePi) => ({
  cwd: "/workspace",
  hasUI,
  model: { provider: "parent", id: "model" },
  thinkingLevel: "high",
  ui: {
    notify: (message: string, level: string) => { pi.notifications.push([message, level]); },
    confirm: async (title: string, message: string) => {
      pi.confirmations.push([title, message]);
      return true;
    },
  },
});
