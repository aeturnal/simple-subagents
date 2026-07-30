import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  AgentsParams,
  ControlParams,
  StartParams,
  StatusParams,
  WaitParams,
  controlJobs,
  listAgents,
  registerSubagentTools,
  startJobs,
  statusJobs,
  waitJobs,
  type ToolServices,
  type WriteConfirmation,
} from "../src/tools.ts";
import {
  createSimpleSubagentsExtension,
  installCompletionNotifier,
  type ExtensionDependencies,
} from "../src/index.js";
import { JobManager } from "../src/job-manager.js";
import type { ProcessResult, ProcessRunOptions, ProcessRunner, RunningProcess } from "../src/process-runner.js";
import { COLLECTED_OUTPUT_MAX_BYTES } from "../src/output.ts";
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
  model: "test-model",
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
    confirmWritable: async () => "approved",
    defaults: () => ({ cwd: "/workspace", parentModel: "parent/model", thinkingLevel: "high" }),
    ...overrides,
  };
  return { services, runner };
};

test("listAgents returns bounded public profiles without private discovery data", async () => {
  const secretProfile: AgentProfile = {
    name: "reviewer",
    description: "Review changed code",
    systemPrompt: "SECRET PROMPT",
    source: "user",
    model: "anthropic/sonnet",
    tools: ["read", "grep"],
    filePath: "/secret/agents/reviewer.md",
  };
  const { services } = createServices(undefined, {
    getProfiles: async () => new Map([
      ["generic", { ...profile, name: "generic", description: "Generic coding agent", source: "builtin" as const }],
      ["reviewer", secretProfile],
    ]),
  });

  const result = await listAgents(services);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.details.profiles?.map((entry) => entry.name), ["generic", "reviewer"]);
  assert.equal(result.details.omittedProfiles, 0);
  assert.match(text(result), /Available subagent profiles/);
  assert.match(text(result), /reviewer — Review changed code/);
  assert.doesNotMatch(serialized, /SECRET PROMPT|\/secret\/agents|systemPrompt|filePath/);
  assert.deepEqual(result.details.jobs, []);
  assert.deepEqual(result.details.diagnostics, []);
});

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

test("startJobs asks once only for an approved writable batch", async () => {
  let confirmations = 0;
  const { services, runner } = createServices(undefined, {
    confirmWritable: async (requests) => {
      confirmations += 1;
      assert.deepEqual(requests.map((request) => request.task), ["write one", "write two"]);
      return "approved";
    },
  });

  const readOnly = await startJobs({ tasks: [{ task: "read" }] }, services, {} as never);
  const approved = await startJobs({ tasks: [{ task: "write one", writeAccess: true }, { task: "write two", writeAccess: true }] }, services, {} as never);

  assert.match(text(readOnly), /Started 1 job/);
  assert.match(text(approved), /Started 2 jobs/);
  assert.equal(confirmations, 1);
  assert.equal(runner.started.length, 3);
});

test("startJobs reports writable jobs declined without enqueueing", async () => {
  const { services, runner } = createServices(undefined, {
    confirmWritable: async () => "declined",
  });

  const declined = await startJobs({ tasks: [{ task: "write", writeAccess: true }] }, services, {} as never);

  assert.equal(declined.content[0]?.text, "Writable jobs were declined.");
  assert.deepEqual(declined.details.diagnostics, ["Writable jobs were declined."]);
  assert.deepEqual(services.manager.list(), []);
  assert.equal(runner.started.length, 0);
});

test("startJobs reports writable confirmation requiring interactive UI without enqueueing", async () => {
  const { services, runner } = createServices(undefined, {
    confirmWritable: async () => "unavailable",
  });

  const unavailable = await startJobs({ tasks: [{ task: "write", writeAccess: true }] }, services, {} as never);

  assert.equal(unavailable.content[0]?.text, "Writable confirmation requires interactive UI.");
  assert.deepEqual(unavailable.details.diagnostics, ["Writable confirmation requires interactive UI."]);
  assert.deepEqual(services.manager.list(), []);
  assert.equal(runner.started.length, 0);
});

test("startJobs fails closed for an invalid writable confirmation outcome", async () => {
  const { services, runner } = createServices(undefined, {
    confirmWritable: async () => false as unknown as WriteConfirmation,
  });

  const invalid = await startJobs({ tasks: [{ task: "write", writeAccess: true }] }, services, {} as never);

  assert.equal(invalid.content[0]?.text, "Writable confirmation requires interactive UI.");
  assert.deepEqual(invalid.details.diagnostics, ["Writable confirmation requires interactive UI."]);
  assert.deepEqual(services.manager.list(), []);
  assert.equal(runner.started.length, 0);
});

test("startJobs lists available profiles for an unknown profile without enqueueing", async () => {
  const { services, runner } = createServices();

  const result = await startJobs({ tasks: [{ task: "inspect", agent: "missing" }] }, services, {} as never);

  const expected = "Unknown agent profile: missing. Available profiles: generic, reviewer.";
  assert.equal(text(result), expected);
  assert.deepEqual(result.details.diagnostics, [expected]);
  assert.deepEqual(result.details.jobs, []);
  assert.equal(runner.started.length, 0);
});

test("startJobs sanitizes line breaks in unknown profile diagnostics", async () => {
  const { services, runner } = createServices();

  const result = await startJobs({ tasks: [{ task: "inspect", agent: "bad\nname" }] }, services, {} as never);

  assert.doesNotMatch(text(result), /\n/);
  assert.doesNotMatch(result.details.diagnostics[0] ?? "", /\n/);
  assert.equal(runner.started.length, 0);
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

test("wait schema bounds IDs, condition, and timeout", () => {
  const schema = WaitParams as unknown as {
    properties: {
      ids: { minItems: number; maxItems: number };
      until: { enum: string[]; default: string };
      timeoutMs: { type: string; minimum: number; maximum: number; default: number };
    };
  };

  assert.equal(schema.properties.ids.minItems, 1);
  assert.equal(schema.properties.ids.maxItems, 8);
  assert.deepEqual(schema.properties.until.enum, ["any", "all"]);
  assert.equal(schema.properties.until.default, "all");
  assert.equal(schema.properties.timeoutMs.type, "integer");
  assert.equal(schema.properties.timeoutMs.minimum, 100);
  assert.equal(schema.properties.timeoutMs.maximum, 30_000);
  assert.equal(schema.properties.timeoutMs.default, 15_000);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 100 }), true);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 30_000 }), true);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 99 }), false);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 30_001 }), false);
  assert.equal(Check(WaitParams, { ids: ["job-1"], timeoutMs: 100.5 }), false);
});

test("waitJobs applies defaults and returns only state snapshots", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "secret task" }] }, services, {} as never);
  runner.started[0]?.resolve(completed("secret output"));
  await runner.flush();

  const result = await waitJobs({ ids: ["job-1"] }, services);

  assert.equal(text(result), "Wait completed: job-1 (completed).");
  assert.ok("outcome" in result.details);
  assert.deepEqual(result.details, {
    operation: "wait",
    outcome: "completed",
    until: "all",
    timeoutMs: 15_000,
    elapsedMs: result.details.elapsedMs,
    jobs: [{ id: "job-1", state: "completed" }],
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret task|secret output|progress|stderr|profile|usage/);
});

test("waitJobs returns atomic diagnostics for duplicate and unknown IDs", async () => {
  const { services } = createServices();
  await startJobs({ tasks: [{ task: "one" }] }, services, {} as never);

  const duplicate = await waitJobs({ ids: ["job-1", "job-1"] }, services);
  const unknown = await waitJobs({ ids: ["job-1", "missing"] }, services);

  assert.equal(text(duplicate), "Duplicate job ID: job-1");
  assert.deepEqual(duplicate.details, {
    jobs: [],
    diagnostics: ["Duplicate job ID: job-1"],
    operation: "wait",
  });
  assert.equal(text(unknown), "Unknown job: missing");
  assert.deepEqual(unknown.details, {
    jobs: [],
    diagnostics: ["Unknown job: missing"],
    operation: "wait",
  });
});

test("waitJobs formats timeout guidance and compact abort text", async () => {
  const timedOutManager = {
    waitFor: async () => ({
      operation: "wait" as const,
      outcome: "timed_out" as const,
      until: "any" as const,
      timeoutMs: 100,
      elapsedMs: 100,
      jobs: [{ id: "job-1", state: "running" as const }],
    }),
  } as unknown as JobManager;
  const timedOut = await waitJobs(
    { ids: ["job-1"], until: "any", timeoutMs: 100 },
    { manager: timedOutManager } as ToolServices,
  );
  assert.equal(
    text(timedOut),
    "Wait timed out after 100 ms: job-1 (running).\nDo not wait again immediately; continue other work or return control.",
  );

  const abortedManager = {
    waitFor: async () => ({
      operation: "wait" as const,
      outcome: "aborted" as const,
      until: "all" as const,
      timeoutMs: 30_000,
      elapsedMs: 5,
      jobs: [{ id: "job-1", state: "running" as const }],
    }),
  } as unknown as JobManager;
  const aborted = await waitJobs(
    { ids: ["job-1"], timeoutMs: 30_000 },
    { manager: abortedManager } as ToolServices,
  );
  assert.equal(text(aborted), "Wait aborted: job-1 (running).");
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

test("controlJobs prevalidates terminal cancellation while preserving cancelled idempotence", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "settled" }, { task: "still running" }] }, services, {} as never);
  runner.started[0]?.resolve(completed());
  await runner.flush();

  const mixed = await controlJobs({ action: "cancel", ids: ["job-1", "job-2"] }, services);

  assert.deepEqual(mixed.details.jobs.map((job) => [job.id, job.state]), [["job-2", "cancelled"]]);
  assert.deepEqual(mixed.details.diagnostics, ["Cannot cancel job in completed state"]);
  assert.equal(runner.started[0]?.cancelled, 0);
  assert.equal(runner.started[1]?.cancelled, 1);

  const repeated = await controlJobs({ action: "cancel", ids: ["job-2"] }, services);

  assert.deepEqual(repeated.details.jobs.map((job) => [job.id, job.state]), [["job-2", "cancelled"]]);
  assert.deepEqual(repeated.details.diagnostics, []);
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
  assert.match(text(result), /Model: test-model/);
  assert.match(text(result), /Usage: input 1, output 2, cache read 3, cache write 4, cost 0.5, turns 1/);
  assert.equal(result.details.jobs[0]?.state, "collected");
  assert.equal(services.manager.get("job-1")?.state, "collected");
});

test("control collection preserves durable capture notices", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "collect capture diagnostics" }] }, services, {} as never);
  runner.started[0]?.resolve({
    ...completed("😀".repeat(12_800)),
    outputTruncation: { originalBytes: 70_000, keptBytes: 50 * 1024 },
  });
  await runner.flush();

  const result = await controlJobs({ action: "collect", ids: ["job-1"] }, services);
  const collected = text(result);
  assert.ok(Buffer.byteLength(collected, "utf8") <= 50 * 1024);
  assert.match(collected, /Output capture truncated: retained 51200 of 70000 bytes/);
});

test("control collection caps eight maximum-size results before collecting all snapshots", async () => {
  const { services, runner } = createServices();
  await startJobs(
    { tasks: Array.from({ length: 8 }, (_, index) => ({ task: `collect result ${index + 1}` })) },
    services,
    {} as never,
  );
  for (const started of runner.started.slice(0, 4)) started.resolve(completed("😀".repeat(12_800)));
  await runner.flush();
  for (const started of runner.started.slice(4)) started.resolve(completed("😀".repeat(12_800)));
  await runner.flush();

  const result = await controlJobs({ action: "collect", ids: Array.from({ length: 8 }, (_, index) => `job-${index + 1}`) }, services);
  const collected = text(result);
  const collectedBytes = Buffer.byteLength(collected, "utf8");

  assert.ok(collectedBytes <= COLLECTED_OUTPUT_MAX_BYTES, `collected ${collectedBytes} bytes, exceeding the ${COLLECTED_OUTPUT_MAX_BYTES}-byte cap`);
  assert.equal(Buffer.from(collected, "utf8").toString("utf8"), collected);
  assert.doesNotMatch(collected, /\uFFFD/);
  assert.match(collected, /\n\nOutput truncated: retained \d+ of \d+ bytes\.$/);
  assert.deepEqual(result.details.jobs.map((job) => [job.id, job.state]), Array.from({ length: 8 }, (_, index) => [`job-${index + 1}`, "collected"]));
  assert.deepEqual(services.manager.list().map((job) => [job.id, job.state]), Array.from({ length: 8 }, (_, index) => [`job-${index + 1}`, "collected"]));
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

test("controlJobs discards multiple completed jobs without placing output into model content", async () => {
  const { services, runner } = createServices();
  await startJobs({ tasks: [{ task: "discard one" }, { task: "discard two" }] }, services, {} as never);
  runner.started[0]?.resolve(completed("do not surface one"));
  runner.started[1]?.resolve(completed("do not surface two"));
  await runner.flush();

  const result = await controlJobs({ action: "discard", ids: ["job-1", "job-2"] }, services);

  assert.deepEqual(result.details.jobs.map((job) => [job.id, job.state]), [["job-1", "discarded"], ["job-2", "discarded"]]);
  assert.doesNotMatch(text(result), /do not surface/);
});

test("tool renderers preserve task detail when expanded and keep compact control outcomes concise", async () => {
  const pi = new FakePi();
  const { services, runner } = createServices();
  registerSubagentTools(pi as never, services);
  const theme = { fg: (_color: string, value: string) => value };
  const render = (toolName: string, result: unknown, expanded: boolean): string =>
    pi.tools.get(toolName)?.renderResult(result, { expanded }, theme).render(160).join("\n") ?? "";

  const started = await startJobs({ tasks: [{ task: "one" }, { task: "two" }] }, services, {} as never);
  const compactStart = render("subagent_start", started, false);
  assert.match(compactStart, /Started 2 jobs/);
  assert.match(compactStart, /… job-1 running/);
  assert.match(compactStart, /… job-2 running/);
  assert.match(render("subagent_start", started, true), /  one\s+  two/);

  runner.started[0]?.resolve(completed("collected secret"));
  await runner.flush();
  const successfulStatus = await statusJobs({ id: "job-1" }, services);
  const compactStatus = render("subagent_status", successfulStatus, false);
  assert.match(compactStatus, /Jobs: 1/);
  assert.match(compactStatus, /✓ job-1 completed/);
  assert.doesNotMatch(compactStatus, /  one/);
  assert.match(render("subagent_status", successfulStatus, true), /  one/);

  const collected = await controlJobs({ action: "collect", ids: ["job-1"] }, services);
  const compactCollect = render("subagent_control", collected, false);
  assert.match(compactCollect, /Collected 1 result/);
  assert.match(compactCollect, /↳ job-1 collected/);
  assert.doesNotMatch(compactCollect, /collected secret/);
  assert.match(render("subagent_control", collected, true), /collected secret/);

  const unknown = await statusJobs({ id: "missing" }, services);
  const declined = await startJobs(
    { tasks: [{ task: "write", writeAccess: true }] },
    { ...services, confirmWritable: async () => "declined" },
    {} as never,
  );
  const invalid = await controlJobs({ action: "collect", ids: ["job-2"] }, services);
  const compactUnknown = render("subagent_status", unknown, false);
  assert.match(compactUnknown, /Unknown job: missing/);
  for (const rendered of [
    compactUnknown,
    render("subagent_start", declined, false),
    render("subagent_control", invalid, false),
  ]) assert.doesNotMatch(rendered, /No jobs/);
  assert.match(render("subagent_status", unknown, true), /Unknown job: missing/);
  assert.match(render("subagent_start", declined, true), /Writable jobs were declined\./);
  assert.match(render("subagent_control", invalid, true), /Cannot collect/i);

  const agents = await listAgents(services);
  const compactAgents = render("subagent_agents", agents, false);
  assert.match(compactAgents, /Available subagent profiles:/);
  assert.match(compactAgents, /- generic — Reviews code/);
  assert.match(compactAgents, /- reviewer — Reviews code/);
  assert.doesNotMatch(compactAgents, /Configured model|launch allowlist/);
  const expandedAgents = render("subagent_agents", agents, true);
  assert.match(expandedAgents, /reviewer — Reviews code/);
  assert.match(expandedAgents, /Model: parent model \(inherited\)/);
  assert.match(expandedAgents, /Read-only launch allowlist: none/);
  assert.match(expandedAgents, /Writable launch allowlist: none/);
  assert.match(expandedAgents, /Supports write-capable tools: no/);

  await controlJobs({ action: "cancel", ids: ["job-2"] }, services);
  const discarded = await controlJobs({ action: "discard", ids: ["job-2"] }, services);
  const compactDiscard = render("subagent_control", discarded, false);
  assert.match(compactDiscard, /Discarded 1 job/);
  assert.match(compactDiscard, /⌫ job-2 discarded/);
});

test("registered subagent_wait forwards the parent tool signal without cancelling jobs", async () => {
  const pi = new FakePi();
  const { services, runner } = createServices();
  registerSubagentTools(pi as never, services);
  await startJobs({ tasks: [{ task: "keep running" }] }, services, {} as never);
  const controller = new AbortController();
  const wait = pi.tools.get("subagent_wait");
  assert.ok(wait);

  const executing = wait.execute(
    "call",
    { ids: ["job-1"], until: "all", timeoutMs: 30_000 },
    controller.signal,
    undefined,
    {} as never,
  );
  controller.abort();
  const result = await executing;

  assert.equal(result.details.outcome, "aborted");
  assert.equal(services.manager.get("job-1")?.state, "running");
  assert.equal(runner.started[0]?.cancelled, 0);
});

test("subagent_wait description limits use to one short near-completion wait", () => {
  const pi = new FakePi();
  const { services } = createServices();
  registerSubagentTools(pi as never, services);

  const description = pi.tools.get("subagent_wait")?.description ?? "";
  assert.match(description, /expected to finish soon/i);
  assert.match(description, /no useful parent work/i);
  assert.match(description, /at most 30 seconds/i);
  assert.match(description, /do not.*again immediately/i);
});

test("subagent_wait renderer shows state-only compact and expanded details", () => {
  const pi = new FakePi();
  const { services } = createServices();
  registerSubagentTools(pi as never, services);
  const theme = { fg: (_color: string, value: string) => value };
  const details = {
    operation: "wait" as const,
    outcome: "timed_out" as const,
    until: "all" as const,
    timeoutMs: 15_000,
    elapsedMs: 15_003,
    jobs: [
      { id: "job-1", state: "running" as const },
      { id: "job-2", state: "completed" as const },
    ],
  };
  const result = {
    content: [{ type: "text" as const, text: "Wait timed out after 15000 ms: job-1 (running), job-2 (completed)." }],
    details,
  };
  const renderer = pi.tools.get("subagent_wait")?.renderResult;
  const compact = renderer(result, { expanded: false }, theme).render(160).join("\n");
  const expanded = renderer(result, { expanded: true }, theme).render(160).join("\n");

  assert.match(compact, /Wait timed out/);
  assert.match(compact, /… job-1 running/);
  assert.match(compact, /✓ job-2 completed/);
  assert.doesNotMatch(compact, /Condition|Configured timeout|Elapsed/);
  assert.match(expanded, /Condition: all/);
  assert.match(expanded, /Configured timeout: 15000 ms/);
  assert.match(expanded, /Elapsed: 15003 ms/);
  assert.doesNotMatch(expanded, /output|stderr|task|profile|usage/i);
});

test("startJobs propagates profile and default resolution failures", async () => {
  const profileFailure = createServices(undefined, { getProfiles: async () => { throw new Error("profiles unavailable"); } });
  await assert.rejects(startJobs({ tasks: [{ task: "inspect" }] }, profileFailure.services, {} as never), /profiles unavailable/);

  const defaultFailure = createServices(undefined, { defaults: () => { throw new Error("defaults unavailable"); } });
  await assert.rejects(startJobs({ tasks: [{ task: "inspect" }] }, defaultFailure.services, {} as never), /defaults unavailable/);
});

test("startJobs propagates unexpected manager failures", async () => {
  const { services } = createServices();
  await services.manager.shutdown();

  await assert.rejects(startJobs({ tasks: [{ task: "inspect" }] }, services, {} as never), /shut down/i);
});

test("controlJobs propagates formatter failures", async () => {
  const job = { id: "job-1", state: "completed" } as Job;
  Object.defineProperty(job, "request", { get: () => { throw new Error("formatting unavailable"); } });
  const manager = {
    get: () => job,
    collect: () => job,
  } as unknown as JobManager;

  await assert.rejects(controlJobs({ action: "collect", ids: ["job-1"] }, { manager } as ToolServices), /formatting unavailable/);
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
  const agentsSchema = AgentsParams as unknown as {
    type: string;
    properties: Record<string, unknown>;
    additionalProperties: boolean;
  };
  assert.equal(agentsSchema.type, "object");
  assert.deepEqual(agentsSchema.properties, {});
  assert.equal(agentsSchema.additionalProperties, false);
  assert.match(pi.tools.get("subagent_agents")?.description ?? "", /only when.*unknown/i);
  assert.match(pi.tools.get("subagent_agents")?.description ?? "", /launch allowlist.*not.*authorization/i);

  for (const name of ["subagent_start", "subagent_status", "subagent_control"]) {
    const description = pi.tools.get(name)?.description ?? "";
    assert.match(description, /self-contained/i);
    assert.match(description, /read-only/i);
    assert.match(description, /collected.*context/i);
    assert.match(description, /each job.*50 KiB/i);
    assert.match(description, /batched collection.*50 KiB aggregate/i);
    assert.match(description, /concise.*split.*collect.*individually/i);
    assert.match(description, /non-overlapping/i);
  }
  assert.ok(pi.tools.get("subagent_agents"));
  assert.equal(pi.tools.get("subagent_agents")?.parameters, AgentsParams);
  assert.ok(pi.tools.get("subagent_wait"));
  assert.equal(pi.tools.get("subagent_wait")?.parameters, WaitParams);
  assert.match(pi.tools.get("subagent_wait")?.description ?? "", /at most 30 seconds/i);
});

test("completion notices debounce real terminal transitions at 100 ms, including cancellation, without leaking output", async () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  manager.enqueue(
    [{ task: "first secret", agent: "generic", writeAccess: false }, { task: "second secret", agent: "generic", writeAccess: false }, { task: "third secret", agent: "generic", writeAccess: false }],
    new Map([["generic", { ...profile, name: "generic", source: "builtin" }]]),
    { cwd: "/workspace" },
  );

  runner.started[0]?.resolve(completed("first secret"));
  runner.started[1]?.resolve({ ...completed("second secret"), exitCode: 1 });
  await manager.cancel("job-3");
  await runner.flush();
  assert.deepEqual(timers.delays, [100]);
  timers.runAll();

  assert.equal(pi.messages.length, 1);
  assert.deepEqual(pi.messages[0]?.details, { jobIds: ["job-1", "job-2", "job-3"] });
  assert.equal(
    pi.messages[0]?.content,
    "Jobs may be ready: job-1 (completed), job-2 (failed), job-3 (cancelled).\n" +
      "Check their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.",
  );
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /secret/);
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /ask the user/i);
  assert.deepEqual(pi.messageOptions[0], { deliverAs: "followUp", triggerTurn: true });

  runner.started[2]?.resolve(completed("third secret"));
  await runner.flush();
  assert.equal(timers.pending.length, 0);
  cleanup();
});

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
  assert.equal(fallback.trimEnd(), "Jobs may be ready.");
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

test("completion notifier listener captured before cleanup becomes a shutdown no-op", () => {
  const pi = new FakePi();
  const timers = new FakeTimers();
  let listener: ((jobs: readonly Job[]) => void) | undefined;
  const manager = {
    subscribe(next: (jobs: readonly Job[]) => void) {
      listener = next;
      next([{ id: "job-1", state: "running" } as Job]);
      return () => { listener = undefined; };
    },
  } as unknown as JobManager;
  const cleanup = installCompletionNotifier(pi as never, manager, timers);
  const capturedListener = listener;
  assert.ok(capturedListener);

  cleanup();
  capturedListener([{ id: "job-1", state: "completed" } as Job]);

  assert.equal(pi.messages.length, 0);
  assert.equal(listener, undefined);
  assert.deepEqual(timers.delays, []);
  assert.equal(timers.pending.length, 0);
});

test("runtime loads config only from Pi's agent directory, never the project config directory", async () => {
  const pi = new FakePi();
  const configPaths: string[] = [];
  const dependencies: ExtensionDependencies & { getAgentDir: () => string } = {
    createManager: () => new JobManager({ runner: new ControlledRunner() }),
    getAgentDir: () => "/pi-agent",
    loadConfig: async (path) => {
      configPaths.push(path);
      return { config: { confirmWrites: false } };
    },
    discoverProfiles: async () => ({ agents: [], diagnostics: [] }),
  };

  createSimpleSubagentsExtension(dependencies)(pi as never);
  await pi.emit("session_start", {}, fakeContext({ hasUI: false }, pi));

  assert.deepEqual(configPaths, ["/pi-agent/simple-subagents.json"]);
  assert.equal(configPaths.includes("/workspace/.pi/simple-subagents.json"), false);
});

test("runtime loads config and profiles, surfaces diagnostics, confirms writable starts once, and shuts down cleanly", async () => {
  const pi = new FakePi();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const dependencies: ExtensionDependencies = {
    createManager: () => manager,
    getAgentDir: () => "/pi-agent",
    loadConfig: async (path) => {
      assert.equal(path, "/pi-agent/simple-subagents.json");
      return { config: { confirmWrites: true }, warning: "config warning" };
    },
    discoverProfiles: async () => ({ agents: [{ ...profile, name: "writer" }], diagnostics: ["profile warning"] }),
    setTimer: () => 1,
    clearTimer: () => {},
  };
  createSimpleSubagentsExtension(dependencies)(pi as never);
  await pi.emit("session_start", {}, fakeContext({ hasUI: true }, pi));

  assert.deepEqual(pi.notifications, [["config warning", "warning"], ["profile warning", "warning"]]);
  const agents = pi.tools.get("subagent_agents");
  assert.ok(agents);
  const discovered = await agents.execute("call", {}, undefined, undefined, fakeContext({ hasUI: true }, pi));
  assert.match(text(discovered), /writer/);
  assert.doesNotMatch(JSON.stringify(discovered), /profile warning/);
  const start = pi.tools.get("subagent_start");
  assert.ok(start);
  const result = await start.execute("call", { tasks: [{ task: "write", agent: "writer", writeAccess: true }, { task: "also write", agent: "writer", writeAccess: true }] }, undefined, undefined, fakeContext({ hasUI: true }, pi));
  assert.equal(pi.confirmations.length, 1);
  assert.match(text(result), /Started 2 jobs/);
  assert.deepEqual(runner.started.map(({ options }) => ({
    cwd: options.cwd,
    profile: options.profile.name,
    parentModel: options.parentModel,
    thinkingLevel: options.thinkingLevel,
  })), [
    { cwd: "/workspace", profile: "writer", parentModel: "parent/model", thinkingLevel: "high" },
    { cwd: "/workspace", profile: "writer", parentModel: "parent/model", thinkingLevel: "high" },
  ]);

  const shuttingDown = pi.emit("session_shutdown", { reason: "reload" }, fakeContext({ hasUI: true }, pi));
  assert.equal(runner.started[0]?.cancelled, 1);
  for (const started of runner.started) started.resolve(completed());
  await shuttingDown;
  await pi.emit("session_shutdown", {}, fakeContext({ hasUI: true }, pi));
});

test("runtime reports writable jobs declined when UI confirmation rejects", async () => {
  const pi = new FakePi();
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  createSimpleSubagentsExtension({
    createManager: () => manager,
    loadConfig: async () => ({ config: { confirmWrites: true } }),
    discoverProfiles: async () => ({ agents: [{ ...profile, name: "writer" }], diagnostics: [] }),
  })(pi as never);
  await pi.emit("session_start", {}, fakeContext({ hasUI: true, confirmResult: false }, pi));

  const start = pi.tools.get("subagent_start");
  assert.ok(start);
  const declined = await start.execute("call", { tasks: [{ task: "write", agent: "writer", writeAccess: true }] }, undefined, undefined, fakeContext({ hasUI: true, confirmResult: false }, pi));

  assert.equal(declined.content[0]?.text, "Writable jobs were declined.");
  assert.deepEqual(declined.details.diagnostics, ["Writable jobs were declined."]);
  assert.equal(pi.confirmations.length, 1);
  assert.deepEqual(manager.list(), []);
  assert.equal(runner.started.length, 0);
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

test("runtime reports writable confirmation requiring interactive UI when confirmation cannot be shown", async () => {
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

  assert.equal(result.content[0]?.text, "Writable confirmation requires interactive UI.");
  assert.deepEqual(result.details.diagnostics, ["Writable confirmation requires interactive UI."]);
  assert.deepEqual(manager.list(), []);
  assert.equal(pi.messageRenderers.has("simple-subagents-ready"), true);
  assert.ok(pi.tools.get("subagent_start")?.renderCall);
  assert.ok(pi.tools.get("subagent_start")?.renderResult);
});

class FakeTimers {
  pending: Array<() => void> = [];
  delays: number[] = [];
  setTimer = (callback: () => void, delay: number): number => {
    this.delays.push(delay);
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
  sendError: Error | undefined;
  sendAttempts = 0;
  readonly notifications: Array<[string, string]> = [];
  readonly confirmations: Array<[string, string]> = [];
  readonly messageRenderers = new Map<string, unknown>();
  readonly commands = new Map<string, unknown>();

  registerTool(tool: any): void { this.tools.set(tool.name, tool); }
  registerCommand(name: string, command: unknown): void { this.commands.set(name, command); }
  on(event: string, handler: (event: unknown, ctx: any) => unknown): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
  async emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
  sendMessage(message: { customType: string; content: string; display: boolean; details: unknown }, options: unknown): void {
    this.sendAttempts += 1;
    if (this.sendError) throw this.sendError;
    this.messages.push(message);
    this.messageOptions.push(options);
  }
  registerMessageRenderer(type: string, renderer: unknown): void { this.messageRenderers.set(type, renderer); }
}

const fakeContext = ({ hasUI, confirmResult = true }: { hasUI: boolean; confirmResult?: boolean }, pi: FakePi) => ({
  cwd: "/workspace",
  hasUI,
  model: { provider: "parent", id: "model" },
  thinkingLevel: "high",
  ui: {
    notify: (message: string, level: string) => { pi.notifications.push([message, level]); },
    confirm: async (title: string, message: string) => {
      pi.confirmations.push([title, message]);
      return confirmResult;
    },
  },
});
