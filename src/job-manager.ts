import type { ProcessResult, ProcessRunner, RunningProcess } from "./process-runner.js";
import { CAPTURED_TEXT_MAX_BYTES, MALFORMED_EVENT_SAMPLE_MAX_BYTES, truncateUtf8 } from "./output.js";
import { isSettled, type AgentProfile, type Job, type JobRequest, type JobState, type ProgressItem, type UsageStats } from "./types.js";

const MAX_CONCURRENCY = 4;
const MAX_BATCH_SIZE = 8;
const MAX_PROGRESS_ITEMS = 200;

export type WaitUntil = "any" | "all";
export type WaitOutcome = "completed" | "timed_out" | "aborted";

export interface WaitJobStatus {
  id: string;
  state: JobState;
}

export interface WaitResult {
  operation: "wait";
  outcome: WaitOutcome;
  until: WaitUntil;
  timeoutMs: number;
  elapsedMs: number;
  jobs: WaitJobStatus[];
}

export interface WaitForOptions {
  ids: readonly string[];
  until: WaitUntil;
  timeoutMs: number;
  signal?: AbortSignal;
}

const emptyUsage = (): UsageStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

interface InternalJob {
  job: Job;
  defaults: { cwd: string; parentModel?: string; thinkingLevel?: string };
  cancellationRequested: boolean;
  cancellation?: Promise<void>;
}

interface StartingRun {
  settled: Promise<void>;
  settle(): void;
  cancellation?: Promise<void>;
  resolveCancellation?: () => void;
}

export class JobManager {
  private readonly runner: ProcessRunner;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly queue: string[] = [];
  private readonly active = new Map<string, RunningProcess>();
  private readonly starting = new Map<string, StartingRun>();
  private readonly subscribers = new Set<(jobs: readonly Job[]) => void>();
  private nextId = 1;
  private stopped = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: {
    runner: ProcessRunner;
    concurrency?: number;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  }) {
    const concurrency = options.concurrency ?? MAX_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      throw new Error("Concurrency must be an integer between 1 and 4");
    }

    this.runner = options.runner;
    this.concurrency = concurrency;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  enqueue(
    requests: JobRequest[],
    profiles: ReadonlyMap<string, AgentProfile>,
    defaults: { cwd: string; parentModel?: string; thinkingLevel?: string },
  ): Job[] {
    if (this.stopped) throw new Error("Job manager has been shut down");
    if (requests.length === 0) throw new Error("Enqueue requires at least one job");
    if (requests.length > MAX_BATCH_SIZE) throw new Error("Enqueue accepts at most eight jobs");

    const selected = requests.map((request) => {
      const profile = profiles.get(request.agent);
      if (!profile) throw new Error(`Unknown agent profile: ${request.agent}`);
      return { request, profile };
    });

    const createdAt = this.now();
    const added: InternalJob[] = selected.map(({ request, profile }) => ({
      defaults: { ...defaults },
      cancellationRequested: false,
      job: {
        id: `job-${this.nextId++}`,
        request: structuredClone(request),
        profile: structuredClone(profile),
        state: "queued",
        createdAt,
        progress: [],
        output: "",
        stderr: "",
        usage: emptyUsage(),
        malformedEventCount: 0,
      },
    }));

    for (const entry of added) {
      this.jobs.set(entry.job.id, entry);
      this.queue.push(entry.job.id);
    }
    this.notify();
    this.pump();
    return added.map((entry) => this.snapshot(entry.job));
  }

  list(): readonly Job[] {
    return [...this.jobs.values()].map((entry) => this.snapshot(entry.job));
  }

  get(id: string): Job | undefined {
    const entry = this.jobs.get(id);
    return entry ? this.snapshot(entry.job) : undefined;
  }

  async cancel(id: string): Promise<Job> {
    const entry = this.requireJob(id);
    if (this.isTerminal(entry.job.state)) return this.snapshot(entry.job);
    if (entry.cancellation) {
      await entry.cancellation;
      return this.snapshot(entry.job);
    }

    entry.cancellationRequested = true;
    if (entry.job.state === "queued") {
      this.finish(entry, "cancelled");
      return this.snapshot(entry.job);
    }

    const starting = this.starting.get(id);
    const process = this.active.get(id);
    if (starting) await this.startingCancellation(starting);
    else if (process) await this.cancelActive(entry, process);
    else if (entry.job.state === "running") this.finish(entry, "cancelled");
    return this.snapshot(entry.job);
  }

  collect(id: string): Job {
    const entry = this.requireJob(id);
    if (entry.job.state === "collected") return this.snapshot(entry.job);
    if (!this.isInboxState(entry.job.state)) throw new Error(`Cannot collect job in ${entry.job.state} state`);

    entry.job.state = "collected";
    this.notify();
    return this.snapshot(entry.job);
  }

  discard(id: string): Job {
    const entry = this.requireJob(id);
    if (entry.job.state === "discarded") return this.snapshot(entry.job);
    if (!this.isInboxState(entry.job.state)) throw new Error(`Cannot discard job in ${entry.job.state} state`);

    entry.job.state = "discarded";
    this.notify();
    return this.snapshot(entry.job);
  }

  subscribe(listener: (jobs: readonly Job[]) => void): () => void {
    this.subscribers.add(listener);
    try {
      listener(this.list());
    } catch {
      // A listener cannot disrupt the manager.
    }
    return () => this.subscribers.delete(listener);
  }

  async waitFor(options: WaitForOptions): Promise<WaitResult> {
    const seen = new Set<string>();
    for (const id of options.ids) {
      if (seen.has(id)) throw new Error(`Duplicate job ID: ${id}`);
      seen.add(id);
      this.requireJob(id);
    }

    const startedAt = this.now();
    const jobs = this.waitSnapshots(options.ids);
    if (this.waitSatisfied(jobs, options.until)) {
      return {
        operation: "wait",
        outcome: "completed",
        until: options.until,
        timeoutMs: options.timeoutMs,
        elapsedMs: this.now() - startedAt,
        jobs,
      };
    }

    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;

      const settleCompleted = () => {
        if (settled) return;
        const current = this.waitSnapshots(options.ids);
        if (!this.waitSatisfied(current, options.until)) return;
        settled = true;
        unsubscribe?.();
        resolve({
          operation: "wait",
          outcome: "completed",
          until: options.until,
          timeoutMs: options.timeoutMs,
          elapsedMs: this.now() - startedAt,
          jobs: current,
        });
      };

      unsubscribe = this.subscribe(settleCompleted);
      if (settled) unsubscribe();
    });
  }

  private waitSnapshots(ids: readonly string[]): WaitJobStatus[] {
    return ids.map((id) => {
      const entry = this.requireJob(id);
      return { id, state: entry.job.state };
    });
  }

  private waitSatisfied(jobs: readonly WaitJobStatus[], until: WaitUntil): boolean {
    return until === "any"
      ? jobs.some((job) => isSettled(job.state))
      : jobs.every((job) => isSettled(job.state));
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;

    for (const id of this.queue) {
      const entry = this.jobs.get(id);
      if (entry?.job.state === "queued") {
        entry.cancellationRequested = true;
        this.finish(entry, "cancelled");
      }
    }

    const running = [...this.active.entries()];
    const starting = [...this.starting.entries()];
    for (const [id] of running) this.requireJob(id).cancellationRequested = true;
    for (const [id] of starting) this.requireJob(id).cancellationRequested = true;
    this.shutdownPromise = Promise.allSettled([
      ...running.map(([id, process]) => this.cancelActive(this.requireJob(id), process)),
      ...starting.map(([, reservation]) => this.startingCancellation(reservation)),
    ])
      .then(() => Promise.allSettled([...running.map(([, process]) => process.result), ...starting.map(([, reservation]) => reservation.settled)]))
      .then(() => undefined);
    return this.shutdownPromise;
  }

  private pump(): void {
    if (this.stopped) return;

    while (this.active.size + this.starting.size < this.concurrency) {
      const id = this.queue.shift();
      if (!id) return;
      const entry = this.jobs.get(id);
      if (!entry || entry.job.state !== "queued") continue;

      let resolveSettled!: () => void;
      let reservationSettled = false;
      const reservation: StartingRun = {
        settled: new Promise<void>((resolve) => {
          resolveSettled = resolve;
        }),
        settle: () => {
          if (!reservationSettled) {
            reservationSettled = true;
            resolveSettled();
          }
        },
      };
      this.starting.set(id, reservation);
      entry.job.state = "running";
      entry.job.startedAt = this.now();
      const synchronousProgress: ProgressItem[] = [];
      let registered = false;

      let process: RunningProcess;
      try {
        process = this.runner.run({
          cwd: entry.job.request.cwd ?? entry.defaults.cwd,
          request: structuredClone(entry.job.request),
          profile: structuredClone(entry.job.profile),
          parentModel: entry.defaults.parentModel,
          thinkingLevel: entry.defaults.thinkingLevel,
          onProgress: (item) => {
            if (registered) this.addProgress(entry, item);
            else synchronousProgress.push(structuredClone(item));
          },
        });
      } catch (error) {
        this.starting.delete(id);
        this.applyResult(entry, this.errorResult(error), true);
        reservation.resolveCancellation?.();
        reservation.settle();
        continue;
      }

      this.active.set(id, process);
      registered = true;
      void process.result.then(
        (result) => {
          this.applyResult(entry, result);
          reservation.settle();
        },
        (error: unknown) => {
          this.applyResult(entry, this.errorResult(error));
          reservation.settle();
        },
      );
      this.starting.delete(id);
      if (entry.cancellationRequested) {
        void this.cancelActive(entry, process).then(() => reservation.resolveCancellation?.());
      }
      if (synchronousProgress.length === 0) {
        this.notify();
      } else {
        for (const item of synchronousProgress) this.addProgress(entry, item);
      }
    }
  }

  private startingCancellation(reservation: StartingRun): Promise<void> {
    if (!reservation.cancellation) {
      reservation.cancellation = new Promise<void>((resolve) => {
        reservation.resolveCancellation = resolve;
      });
    }
    return reservation.cancellation;
  }

  private cancelActive(entry: InternalJob, process: RunningProcess): Promise<void> {
    if (entry.cancellation) return entry.cancellation;

    let cancellation: Promise<void>;
    try {
      cancellation = process.cancel();
    } catch {
      cancellation = Promise.resolve();
    }
    entry.cancellation = cancellation.catch(() => undefined).then(() => {
      if (entry.job.state === "running") this.finish(entry, "cancelled");
    });
    return entry.cancellation;
  }

  private addProgress(entry: InternalJob, item: ProgressItem): void {
    if (entry.job.state !== "running" && entry.job.state !== "cancelled") return;

    if (item.type === "text") {
      const captured = truncateUtf8(item.text, CAPTURED_TEXT_MAX_BYTES);
      const originalBytes = item.truncation?.originalBytes ?? Buffer.byteLength(item.text, "utf8");
      const keptBytes = Buffer.byteLength(captured.text, "utf8");
      const truncation = originalBytes > keptBytes ? { originalBytes, keptBytes } : undefined;
      entry.job.progress = entry.job.progress.filter((progress) => progress.type !== "text");
      if (captured.text) entry.job.progress.push(structuredClone({ ...item, text: captured.text, truncation }));
    } else {
      entry.job.progress.push(structuredClone(item));
      const nonTextOverflow = entry.job.progress.filter((progress) => progress.type !== "text").length - MAX_PROGRESS_ITEMS;
      if (nonTextOverflow > 0) {
        let remaining = nonTextOverflow;
        entry.job.progress = entry.job.progress.filter((progress) => progress.type === "text" || remaining-- <= 0);
      }
    }
    this.notify();
  }

  private applyResult(entry: InternalJob, result: ProcessResult, forceFailure = false): void {
    this.active.delete(entry.job.id);
    const output = truncateUtf8(result.output, CAPTURED_TEXT_MAX_BYTES);
    const stderr = truncateUtf8(result.stderr, CAPTURED_TEXT_MAX_BYTES);
    entry.job.output = output.text;
    entry.job.stderr = stderr.text;
    const error = result.errorMessage ? truncateUtf8(result.errorMessage, CAPTURED_TEXT_MAX_BYTES) : undefined;
    const errorOriginalBytes = result.errorTruncation?.originalBytes ?? Buffer.byteLength(result.errorMessage ?? "", "utf8");
    const errorKeptBytes = Buffer.byteLength(error?.text ?? "", "utf8");
    entry.job.errorMessage = error?.text;
    entry.job.errorTruncation = errorOriginalBytes > errorKeptBytes ? { originalBytes: errorOriginalBytes, keptBytes: errorKeptBytes } : undefined;
    entry.job.usage = structuredClone(result.usage);
    entry.job.model = result.model;
    entry.job.stopReason = result.stopReason;
    entry.job.malformedEventCount = result.malformedEventCount;
    entry.job.malformedEventSamples = result.malformedEventSamples
      ?.slice(0, 3)
      .map((sample) => truncateUtf8(sample, MALFORMED_EVENT_SAMPLE_MAX_BYTES).text);
    entry.job.outputTruncation = result.outputTruncation ?? output.truncation;
    entry.job.stderrTruncation = result.stderrTruncation ?? stderr.truncation;

    if (entry.job.state === "running") {
      this.finish(entry, forceFailure ? "failed" : entry.cancellationRequested ? "cancelled" : this.resultState(result));
    } else {
      this.notify();
      this.pump();
    }
  }

  private finish(entry: InternalJob, state: "completed" | "failed" | "cancelled"): void {
    if (entry.job.state !== "queued" && entry.job.state !== "running") return;

    entry.job.state = state;
    entry.job.finishedAt = this.now();
    this.notify();
    this.pump();
  }

  private resultState(result: ProcessResult): "completed" | "failed" {
    return result.exitCode === 0 && result.stopReason !== "error" && result.output.length > 0 ? "completed" : "failed";
  }

  private errorResult(error: unknown): ProcessResult {
    return {
      exitCode: 1,
      output: "",
      stderr: error instanceof Error ? error.message : String(error),
      usage: emptyUsage(),
      malformedEventCount: 0,
    };
  }

  private requireJob(id: string): InternalJob {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error(`Unknown job: ${id}`);
    return entry;
  }

  private isInboxState(state: JobState): state is "completed" | "failed" | "cancelled" {
    return state === "completed" || state === "failed" || state === "cancelled";
  }

  private isTerminal(state: JobState): boolean {
    return state === "completed" || state === "failed" || state === "cancelled" || state === "collected" || state === "discarded";
  }

  private notify(): void {
    for (const listener of this.subscribers) {
      try {
        listener(this.list());
      } catch {
        // A listener cannot disrupt the manager or later listeners.
      }
    }
  }

  private snapshot(job: Job): Job {
    return structuredClone(job);
  }
}
