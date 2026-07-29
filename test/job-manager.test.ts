import assert from "node:assert/strict";
import test from "node:test";
import { JobManager } from "../src/job-manager.js";
import type { ProcessResult, ProcessRunOptions, ProcessRunner, RunningProcess } from "../src/process-runner.ts";
import type { AgentProfile, JobRequest, ProgressItem, UsageStats } from "../src/types.ts";

const usage = (): UsageStats => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 });

const successfulResult = (output: string): ProcessResult => ({
  exitCode: 0,
  output,
  stderr: "",
  usage: usage(),
  model: "test-model",
  stopReason: "stop",
  malformedEventCount: 0,
});

const failedResult = (overrides: Partial<ProcessResult> = {}): ProcessResult => ({
  ...successfulResult("partial output"),
  exitCode: 1,
  stderr: "process failed",
  ...overrides,
});

const profile: AgentProfile = {
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  source: "user",
};

const profiles = new Map([[profile.name, profile]]);
const defaults = { cwd: "/workspace", parentModel: "parent-model", thinkingLevel: "high" };

const makeRequests = (count: number): JobRequest[] =>
  Array.from({ length: count }, (_, index) => ({ task: `Task ${index + 1}`, agent: "reviewer", writeAccess: false }));

interface StartedRun {
  options: ProcessRunOptions;
  resolve(result: ProcessResult): void;
  reject(error: Error): void;
  cancelCalls: number;
  releaseCancel(): void;
  rejectCancel(error: Error): void;
}

class ControlledRunner implements ProcessRunner {
  readonly started: StartedRun[] = [];

  run(options: ProcessRunOptions): RunningProcess {
    let resolve!: (result: ProcessResult) => void;
    let reject!: (error: Error) => void;
    let releaseCancel!: () => void;
    let rejectCancel!: (error: Error) => void;
    const result = new Promise<ProcessResult>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const cancelGate = new Promise<void>((nextResolve, nextReject) => {
      releaseCancel = nextResolve;
      rejectCancel = nextReject;
    });
    const started: StartedRun = { options, resolve, reject, cancelCalls: 0, releaseCancel, rejectCancel };
    this.started.push(started);

    return {
      result,
      cancel: async () => {
        started.cancelCalls += 1;
        await cancelGate;
      },
    };
  }

  complete(index: number, result: ProcessResult): void {
    this.started[index]?.resolve(result);
  }

  fail(index: number, error: Error): void {
    this.started[index]?.reject(error);
  }

  progress(index: number, item: ProgressItem): void {
    this.started[index]?.options.onProgress(item);
  }

  releaseCancel(index: number): void {
    this.started[index]?.releaseCancel();
  }

  rejectCancel(index: number, error: Error): void {
    this.started[index]?.rejectCancel(error);
  }

  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class SynchronousProgressRunner extends ControlledRunner {
  run(options: ProcessRunOptions): RunningProcess {
    options.onProgress({ type: "tool", text: "synchronous", timestamp: 1 });
    return super.run(options);
  }
}

class ThrowingRunner implements ProcessRunner {
  run(_options: ProcessRunOptions): RunningProcess {
    throw new Error("could not start");
  }
}

test("starts no more than the default four jobs and pumps FIFO when a slot opens", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, now: () => 100 });

  manager.enqueue(makeRequests(5), profiles, defaults);
  assert.equal(runner.started.length, 4);
  assert.deepEqual(runner.started.map((started) => started.options.request.task), ["Task 1", "Task 2", "Task 3", "Task 4"]);

  runner.complete(1, successfulResult("two"));
  await runner.flush();

  assert.equal(runner.started.length, 5);
  assert.equal(runner.started[4]?.options.request.task, "Task 5");
  assert.equal(manager.get("job-2")?.state, "completed");
});

test("uses the supplied concurrency limit", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 2, now: () => 100 });

  manager.enqueue(makeRequests(3), profiles, defaults);

  assert.equal(runner.started.length, 2);
  assert.equal(manager.get("job-3")?.state, "queued");
});

test("rejects concurrency outside the absolute range of one through four", () => {
  const runner = new ControlledRunner();

  assert.throws(() => new JobManager({ runner, concurrency: 0 }), /concurrency/i);
  assert.throws(() => new JobManager({ runner, concurrency: 5 }), /concurrency/i);
});

test("rejects an empty batch before adding jobs", () => {
  const manager = new JobManager({ runner: new ControlledRunner() });

  assert.throws(() => manager.enqueue([], profiles, defaults), /at least one/i);
  assert.deepEqual(manager.list(), []);
});

test("rejects batches over eight before adding jobs", () => {
  const manager = new JobManager({ runner: new ControlledRunner() });

  assert.throws(() => manager.enqueue(makeRequests(9), profiles, defaults), /eight/i);
  assert.deepEqual(manager.list(), []);
});

test("rejects unknown profiles before mutating a complete batch", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const requests = [...makeRequests(1), { task: "Unknown", agent: "missing", writeAccess: false }];

  assert.throws(() => manager.enqueue(requests, profiles, defaults), /unknown agent profile/i);
  assert.deepEqual(manager.list(), []);
  assert.equal(runner.started.length, 0);
});

test("assigns stable increasing IDs and passes resolved process options", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1, now: () => 100 });
  const [first] = manager.enqueue([{ ...makeRequests(1)[0]!, cwd: "/request" }], profiles, defaults);
  const [second] = manager.enqueue(makeRequests(1), profiles, defaults);

  assert.equal(first?.id, "job-1");
  assert.equal(second?.id, "job-2");
  assert.equal(first?.createdAt, 100);
  assert.equal(runner.started[0]?.options.cwd, "/request");
  assert.equal(runner.started[0]?.options.parentModel, "parent-model");
  assert.equal(runner.started[0]?.options.thinkingLevel, "high");
});

test("does not publish running work before its process occupies a slot during subscriber enqueue", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  let reentered = false;

  manager.subscribe((jobs) => {
    if (!reentered && jobs[0]?.state === "running") {
      reentered = true;
      manager.enqueue(makeRequests(1), profiles, defaults);
    }
  });
  manager.enqueue(makeRequests(1), profiles, defaults);

  assert.equal(runner.started.length, 1);
  assert.deepEqual(manager.list().map((job) => job.state), ["running", "queued"]);
});

test("routes a re-entrant cancellation to a registered running process", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  let cancellation: Promise<ReturnType<JobManager["get"]>> | undefined;

  manager.subscribe((jobs) => {
    if (!cancellation && jobs[0]?.state === "running") cancellation = manager.cancel(jobs[0].id);
  });
  manager.enqueue(makeRequests(1), profiles, defaults);
  await runner.flush();

  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0]?.cancelCalls, 1);
  runner.releaseCancel(0);
  assert.equal((await cancellation)?.state, "cancelled");
});

test("waits for a re-entrant shutdown to cancel the registered running process", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  let stopping: Promise<void> | undefined;

  manager.subscribe((jobs) => {
    if (!stopping && jobs[0]?.state === "running") stopping = manager.shutdown();
  });
  manager.enqueue(makeRequests(1), profiles, defaults);
  await runner.flush();

  assert.equal(runner.started.length, 1);
  assert.equal(runner.started[0]?.cancelCalls, 1);
  runner.releaseCancel(0);
  runner.complete(0, successfulResult("late success"));
  await stopping;
  assert.equal(manager.get("job-1")?.state, "cancelled");
});

test("buffers synchronous progress until a running process is registered", async () => {
  const runner = new SynchronousProgressRunner();
  const manager = new JobManager({ runner });
  let cancellation: Promise<ReturnType<JobManager["get"]>> | undefined;

  manager.subscribe((jobs) => {
    if (!cancellation && jobs[0]?.progress.length) cancellation = manager.cancel(jobs[0].id);
  });
  manager.enqueue(makeRequests(1), profiles, defaults);
  await runner.flush();

  assert.equal(runner.started[0]?.cancelCalls, 1);
  runner.releaseCancel(0);
  assert.equal((await cancellation)?.state, "cancelled");
});

test("returns immutable public snapshots", () => {
  const manager = new JobManager({ runner: new ControlledRunner(), now: () => 100 });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  const listed = manager.list();

  assert.ok(job);
  assert.ok(listed[0]);
  job.progress.push({ type: "text", text: "mutated", timestamp: 1 });
  listed[0].request.task = "mutated";

  assert.equal(manager.get(job.id)?.progress.length, 0);
  assert.equal(manager.get(job.id)?.request.task, "Task 1");
});

test("retains only the newest 200 progress items", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  for (let index = 0; index < 201; index += 1) {
    runner.progress(0, { type: "tool", text: `event ${index}`, timestamp: index });
  }

  const progress = manager.get(job.id)?.progress;
  assert.equal(progress?.length, 200);
  assert.equal(progress?.[0]?.text, "event 1");
  assert.equal(progress?.at(-1)?.text, "event 200");
});

test("notifies subscribers of changes and stops after unsubscription", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const updates: string[][] = [];
  const unsubscribe = manager.subscribe((jobs) => updates.push(jobs.map((job) => job.state)));

  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);
  runner.progress(0, { type: "tool", text: "working", timestamp: 1 });
  unsubscribe();
  runner.complete(0, successfulResult("done"));
  await runner.flush();

  assert.deepEqual(updates, [[], ["queued"], ["running"], ["running"]]);
});

test("gives each subscriber an independent job snapshot", () => {
  const manager = new JobManager({ runner: new ControlledRunner() });
  const observedTasks: string[] = [];

  manager.subscribe((jobs) => {
    if (jobs[0]) jobs[0].request.task = "mutated by another listener";
  });
  manager.subscribe((jobs) => observedTasks.push(jobs[0]?.request.task ?? "empty"));
  manager.enqueue(makeRequests(1), profiles, defaults);

  assert.equal(observedTasks.at(-1), "Task 1");
});

test("continues notifying and pumping when a subscriber throws", () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const observedStates: string[][] = [];

  assert.doesNotThrow(() => manager.subscribe(() => {
    throw new Error("listener failed");
  }));
  manager.subscribe((jobs) => observedStates.push(jobs.map((job) => job.state)));

  assert.doesNotThrow(() => manager.enqueue(makeRequests(1), profiles, defaults));
  assert.equal(runner.started.length, 1);
  assert.deepEqual(observedStates.at(-1), ["running"]);
});

test("maps process results to completed and failed states", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 3 });
  const jobs = manager.enqueue(makeRequests(3), profiles, defaults);

  runner.complete(0, failedResult());
  runner.complete(1, failedResult({ exitCode: 0, stopReason: "error" }));
  runner.complete(2, successfulResult(""));
  await runner.flush();

  assert.equal(manager.get(jobs[0]!.id)?.state, "failed");
  assert.equal(manager.get(jobs[1]!.id)?.state, "failed");
  assert.equal(manager.get(jobs[2]!.id)?.state, "failed");
});

test("maps rejected process results to failed jobs", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  runner.fail(0, new Error("runner broke"));
  await runner.flush();

  const failed = manager.get(job.id);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.stderr, "runner broke");
});

test("cancels queued jobs immediately and idempotently", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  const [, queued] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(queued);

  const first = await manager.cancel(queued.id);
  const second = await manager.cancel(queued.id);

  assert.equal(first.state, "cancelled");
  assert.equal(second.state, "cancelled");
  assert.equal(manager.get(queued.id)?.state, "cancelled");
  assert.equal(runner.started.length, 1);
});

test("shares a running cancellation operation between concurrent callers", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  const first = manager.cancel(job.id);
  const second = manager.cancel(job.id);
  assert.equal(runner.started[0]?.cancelCalls, 1);
  runner.releaseCancel(0);

  const [firstCancelled, secondCancelled] = await Promise.all([first, second]);
  assert.equal(firstCancelled.state, "cancelled");
  assert.equal(secondCancelled.state, "cancelled");
});

test("returns a cancelled snapshot when process cancellation rejects but keeps its slot until settlement", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  const [first] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(first);

  const cancelling = manager.cancel(first.id);
  runner.rejectCancel(0, new Error("signal failed"));
  await assert.doesNotReject(cancelling);
  const cancelled = await cancelling;
  const [queued] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(queued);

  assert.equal(cancelled.state, "cancelled");
  assert.equal(manager.get(queued.id)?.state, "queued");
  assert.equal(runner.started.length, 1);
  runner.complete(0, successfulResult("late success"));
  await runner.flush();
  assert.equal(runner.started.length, 2);
});

test("keeps explicit cancellation terminal when process completion races it", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  const cancelling = manager.cancel(job.id);
  assert.equal(runner.started[0]?.cancelCalls, 1);
  runner.complete(0, successfulResult("late success"));
  await runner.flush();
  runner.releaseCancel(0);
  const cancelled = await cancelling;

  assert.equal(cancelled.state, "cancelled");
  assert.equal(manager.get(job.id)?.state, "cancelled");
  assert.equal(manager.get(job.id)?.output, "late success");
});

test("treats repeated collect and discard as idempotent while rejecting cross-transitions", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 2 });
  const [completed, discarded] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(completed && discarded);
  runner.complete(0, successfulResult("done"));
  runner.complete(1, successfulResult("next"));
  await runner.flush();

  assert.equal(manager.collect(completed.id).state, "collected");
  assert.equal(manager.collect(completed.id).state, "collected");
  assert.equal(manager.discard(discarded.id).state, "discarded");
  assert.equal(manager.discard(discarded.id).state, "discarded");
  assert.throws(() => manager.discard(completed.id), /cannot discard/i);
  assert.throws(() => manager.collect(discarded.id), /cannot collect/i);
});

test("collects only settled inbox jobs and discards only settled inbox jobs", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  const [running, queued] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(running && queued);

  assert.throws(() => manager.collect(running.id), /cannot collect/i);
  assert.throws(() => manager.discard(queued.id), /cannot discard/i);
  runner.complete(0, successfulResult("done"));
  await runner.flush();

  assert.equal(manager.collect(running.id).state, "collected");
  runner.complete(1, successfulResult("next"));
  await runner.flush();
  assert.equal(manager.discard(queued.id).state, "discarded");
  assert.throws(() => manager.discard(running.id), /cannot discard/i);
  assert.throws(() => manager.collect(queued.id), /cannot collect/i);
});

test("marks a synchronously throwing runner invocation as failed", () => {
  const manager = new JobManager({ runner: new ThrowingRunner() });
  const [job] = manager.enqueue(makeRequests(1), profiles, defaults);
  assert.ok(job);

  assert.equal(manager.get(job.id)?.state, "failed");
  assert.equal(manager.get(job.id)?.stderr, "could not start");
});

test("shutdown cancels queued and active work then waits for active settlement", async () => {
  const runner = new ControlledRunner();
  const manager = new JobManager({ runner, concurrency: 1 });
  const [active, queued] = manager.enqueue(makeRequests(2), profiles, defaults);
  assert.ok(active && queued);

  const stopping = manager.shutdown();
  const alsoStopping = manager.shutdown();
  let secondShutdownFinished = false;
  void alsoStopping.then(() => {
    secondShutdownFinished = true;
  });
  await runner.flush();
  assert.equal(secondShutdownFinished, false);
  assert.equal(manager.get(queued.id)?.state, "cancelled");
  assert.equal(runner.started[0]?.cancelCalls, 1);

  runner.releaseCancel(0);
  runner.complete(0, successfulResult("late success"));
  await stopping;
  await alsoStopping;

  assert.equal(manager.get(active.id)?.state, "cancelled");
  assert.equal(manager.get(queued.id)?.state, "cancelled");
  assert.equal(runner.started.length, 1);
});
