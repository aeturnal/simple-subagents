import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { JsonLineParser } from "./json-stream.js";
import type { LaunchOptions } from "./launch-options.js";
import { getLaunchToolAllowlist } from "./profile-capabilities.js";
import { CAPTURED_TEXT_MAX_BYTES, truncateUtf8 } from "./output.js";
import type { AgentProfile, JobRequest, ProgressItem, TextTruncation, UsageStats } from "./types.js";

export interface ProcessTelemetry {
  readonly usage: Readonly<UsageStats>;
  readonly model?: string;
}

export interface ProcessRunOptions {
  cwd: string;
  request: JobRequest;
  profile: AgentProfile;
  launchOptions: LaunchOptions;
  onProgress(item: ProgressItem): void;
  onTelemetry?(telemetry: ProcessTelemetry): void;
}

export interface ProcessResult {
  exitCode: number;
  output: string;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  errorTruncation?: TextTruncation;
  malformedEventCount: number;
  malformedEventSamples?: string[];
  outputTruncation?: TextTruncation;
  stderrTruncation?: TextTruncation;
}

export interface RunningProcess {
  result: Promise<ProcessResult>;
  cancel(): Promise<void>;
}

export interface ProcessRunner {
  run(options: ProcessRunOptions): RunningProcess;
}

export interface SpawnOptions {
  cwd: string;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface ProcessStream {
  on(event: "data", listener: (data: Buffer) => void): unknown;
  removeListener(event: "data", listener: (data: Buffer) => void): unknown;
}

export interface SpawnedProcess {
  stdout: ProcessStream;
  stderr: ProcessStream;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: (code: number | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export interface PiProcessRunnerDependencies {
  spawnProcess?(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess;
  setTimer?(callback: () => void, delay: number): unknown;
  clearTimer?(timer: unknown): void;
  fileExists?(path: string): boolean;
  now?(): number;
}

const emptyUsage = (): UsageStats => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

const defaultSpawnProcess = (command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess =>
  spawn(command, args, options) as unknown as SpawnedProcess;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNumber = (value: unknown): number => (typeof value === "number" ? value : 0);

const getAssistantText = (message: Record<string, unknown>): string | undefined => {
  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  for (const part of content) {
    const entry = asRecord(part);
    if (entry?.type === "text" && typeof entry.text === "string") return entry.text;
  }

  return undefined;
};

const getPiInvocation = (args: string[], fileExists: (path: string) => boolean = existsSync): { command: string; args: string[] } => {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fileExists(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
};

const writePrompt = (profile: AgentProfile): { dir: string; path: string } | undefined => {
  if (!profile.systemPrompt.trim()) return undefined;

  const dir = mkdtempSync(join(tmpdir(), "simple-subagents-"));
  const safeName = profile.name.replace(/[^\w.-]+/g, "_");
  const path = join(dir, `prompt-${safeName}.md`);
  writeFileSync(path, profile.systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { dir, path };
};

export class PiProcessRunner implements ProcessRunner {
  private readonly spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly fileExists: (path: string) => boolean;
  private readonly now: () => number;

  constructor(dependencies: PiProcessRunnerDependencies = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
    this.setTimer = dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    this.fileExists = dependencies.fileExists ?? existsSync;
    this.now = dependencies.now ?? Date.now;
  }

  run(options: ProcessRunOptions): RunningProcess {
    const parser = new JsonLineParser();
    const usage = emptyUsage();
    const { modelArgument, thinkingArgument } = options.launchOptions;
    const args = [
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
    ];
    if (modelArgument) args.push("--model", modelArgument);
    if (thinkingArgument) args.push("--thinking", thinkingArgument);

    const accessMode = options.request.writeAccess ? "write" : "read-only";
    const tools = getLaunchToolAllowlist(options.profile, accessMode);
    if (tools.length > 0) args.push("--tools", tools.join(","));
    else if (options.profile.name !== "generic") args.push("--no-tools");

    let prompt: { dir: string; path: string } | undefined;
    let child: SpawnedProcess | undefined;
    let output = "";
    let partialOutput = "";
    let partialOriginalBytes = 0;
    let partialCaptureExhausted = false;
    let outputTruncation: TextTruncation | undefined;
    let stderr = "";
    let stderrOriginalBytes = 0;
    let stderrTruncation: TextTruncation | undefined;
    const stderrDecoder = new StringDecoder("utf8");
    let resultModel = modelArgument;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let errorTruncation: TextTruncation | undefined;
    let settled = false;
    let cancelled = false;
    let escalationTimer: unknown;
    let resolveResult: (result: ProcessResult) => void = () => {};

    const result = new Promise<ProcessResult>((resolve) => {
      resolveResult = resolve;
    });

    let lastReasoningActivityAt: number | undefined;

    const emitProgress = (text: string) => options.onProgress({ type: "tool", text, timestamp: this.now() });
    const emitModelProgress = (text: string, timestamp = this.now()): number => {
      options.onProgress({ type: "model", text, timestamp });
      return timestamp;
    };
    const emitPartial = () => {
      const keptBytes = Buffer.byteLength(partialOutput, "utf8");
      options.onProgress({
        type: "text",
        text: partialOutput,
        timestamp: this.now(),
        truncation: partialOriginalBytes > keptBytes ? { originalBytes: partialOriginalBytes, keptBytes } : undefined,
      });
    };
    const setError = (text: string): void => {
      const captured = truncateUtf8(text, CAPTURED_TEXT_MAX_BYTES);
      errorMessage = captured.text;
      errorTruncation = captured.truncation;
    };
    const appendStderr = (text: string, sourceBytes: number): void => {
      stderrOriginalBytes += sourceBytes;
      const safeChunk = truncateUtf8(text, CAPTURED_TEXT_MAX_BYTES).text;
      stderr = truncateUtf8(stderr + safeChunk, CAPTURED_TEXT_MAX_BYTES).text;
      if (stderrOriginalBytes > CAPTURED_TEXT_MAX_BYTES) {
        stderrTruncation = { originalBytes: stderrOriginalBytes, keptBytes: Buffer.byteLength(stderr, "utf8") };
      }
    };

    const reduceEvent = (event: unknown): void => {
      const record = asRecord(event);
      if (!record) return;

      if (record.type === "turn_start") {
        lastReasoningActivityAt = undefined;
        emitModelProgress("Model turn started");
        return;
      }

      if (record.type === "turn_end") {
        lastReasoningActivityAt = undefined;
        emitModelProgress("Model turn finished");
        return;
      }

      if (record.type === "message_start") {
        const message = asRecord(record.message);
        if (message?.role === "assistant") {
          const hadPartialOutput = partialOutput.length > 0;
          partialOutput = "";
          partialOriginalBytes = 0;
          partialCaptureExhausted = false;
          if (hadPartialOutput) emitPartial();
        }
        return;
      }

      if (record.type === "message_update") {
        const message = asRecord(record.message);
        const assistantEvent = asRecord(record.assistantMessageEvent);
        if (message?.role !== "assistant" || !assistantEvent) return;

        if (assistantEvent.type === "thinking_start") {
          lastReasoningActivityAt = emitModelProgress("Model reasoning");
          return;
        }

        if (assistantEvent.type === "thinking_delta") {
          const timestamp = this.now();
          if (lastReasoningActivityAt === undefined || timestamp - lastReasoningActivityAt >= 5_000) {
            lastReasoningActivityAt = emitModelProgress("Model reasoning", timestamp);
          }
          return;
        }

        if (assistantEvent.type === "thinking_end") {
          emitModelProgress("Model reasoning finished");
          lastReasoningActivityAt = undefined;
          return;
        }

        if (assistantEvent.type === "text_delta") {
          const delta = asString(assistantEvent.delta);
          if (delta !== undefined) {
            partialOriginalBytes += Buffer.byteLength(delta, "utf8");
            if (!partialCaptureExhausted) {
              const captured = truncateUtf8(partialOutput + delta, CAPTURED_TEXT_MAX_BYTES);
              partialOutput = captured.text;
              partialCaptureExhausted = captured.truncation !== undefined;
            }
            emitPartial();
          }
        }
        return;
      }

      if (record.type === "message_end") {
        const message = asRecord(record.message);
        if (!message || message.role !== "assistant") return;

        usage.turns += 1;
        const text = getAssistantText(message);
        if (text !== undefined) {
          const captured = truncateUtf8(text, CAPTURED_TEXT_MAX_BYTES);
          output = captured.text;
          outputTruncation = captured.truncation;
        }
        if (partialOutput) {
          partialOutput = "";
          emitPartial();
        }
        partialOriginalBytes = 0;
        partialCaptureExhausted = false;
        const eventUsage = asRecord(message.usage);
        if (eventUsage) {
          usage.input += asNumber(eventUsage.input);
          usage.output += asNumber(eventUsage.output);
          usage.cacheRead += asNumber(eventUsage.cacheRead);
          usage.cacheWrite += asNumber(eventUsage.cacheWrite);
          const cost = asRecord(eventUsage.cost);
          usage.cost += cost ? asNumber(cost.total) : asNumber(eventUsage.cost);
        }
        const reportedModel = asString(message.model);
        resultModel = reportedModel ?? resultModel;
        options.onTelemetry?.({
          usage: { ...usage },
          ...(reportedModel === undefined ? {} : { model: reportedModel }),
        });
        stopReason = asString(message.stopReason) ?? stopReason;
        const nextErrorMessage = asString(message.errorMessage);
        if (nextErrorMessage !== undefined) setError(nextErrorMessage);
        return;
      }

      if (record.type === "tool_execution_start") emitProgress(`Started ${asString(record.toolName) ?? "tool"}`);
      else if (record.type === "tool_execution_update") emitProgress(`Updated ${asString(record.toolName) ?? "tool"}`);
      else if (record.type === "tool_execution_end") emitProgress(`Completed ${asString(record.toolName) ?? "tool"}`);
      else if (record.type === "tool_result_end") emitProgress("Tool result received");
    };

    const onStdout = (data: Buffer) => {
      for (const event of parser.push(data)) reduceEvent(event);
    };
    const onStderr = (data: Buffer) => {
      appendStderr(stderrDecoder.write(data), data.byteLength);
    };
    const cleanup = () => {
      if (child) {
        child.stdout.removeListener("data", onStdout);
        child.stderr.removeListener("data", onStderr);
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
      }
      if (escalationTimer !== undefined) {
        this.clearTimer(escalationTimer);
        escalationTimer = undefined;
      }
      if (prompt) {
        rmSync(prompt.dir, { recursive: true, force: true });
        prompt = undefined;
      }
    };
    const settle = (exitCode: number, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      for (const event of parser.finish()) reduceEvent(event);
      appendStderr(stderrDecoder.end(), 0);
      if (spawnError) setError(spawnError.message);
      cleanup();
      resolveResult({
        exitCode,
        output,
        stderr,
        usage,
        model: resultModel,
        stopReason,
        errorMessage,
        errorTruncation,
        malformedEventCount: parser.malformedCount,
        malformedEventSamples: [...parser.malformedSamples],
        outputTruncation,
        stderrTruncation,
      });
    };
    const onClose = (code: number | null) => settle(code ?? 1);
    const onError = (error: Error) => settle(1, error);

    try {
      prompt = writePrompt(options.profile);
      if (prompt) args.push("--append-system-prompt", prompt.path);
      args.push(options.request.task);
      const invocation = getPiInvocation(args, this.fileExists);
      child = this.spawnProcess(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("close", onClose);
      child.on("error", onError);
    } catch (error) {
      settle(1, error instanceof Error ? error : new Error(String(error)));
    }

    return {
      result,
      cancel: () => {
        if (!settled && !cancelled && child) {
          cancelled = true;
          child.kill("SIGTERM");
          escalationTimer = this.setTimer(() => {
            if (!settled) child?.kill("SIGKILL");
          }, 5_000);
        }
        return Promise.resolve();
      },
    };
  }
}
