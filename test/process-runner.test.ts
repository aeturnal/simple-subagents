import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { resolveLaunchOptions } from "../src/launch-options.ts";
import { CAPTURED_TEXT_MAX_BYTES } from "../src/output.ts";
import { getLaunchToolAllowlist } from "../src/profile-capabilities.ts";
import { PiProcessRunner, type ProcessRunOptions } from "../src/process-runner.ts";
import type { AgentProfile, JobRequest, ProgressItem } from "../src/types.ts";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  close(code: number | null = 0, signal?: NodeJS.Signals): void {
    this.emit("close", code, signal);
  }
}

const request = (writeAccess = false): JobRequest => ({
  task: "Inspect the repository",
  agent: "reviewer",
  writeAccess,
});

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  source: "user",
  ...overrides,
});

const runOptions = (overrides: Partial<ProcessRunOptions> = {}): ProcessRunOptions => {
  const nextRequest = overrides.request ?? request();
  const nextProfile = overrides.profile ?? profile({ systemPrompt: "" });
  return {
    cwd: overrides.cwd ?? "/workspace",
    request: nextRequest,
    profile: nextProfile,
    launchOptions: overrides.launchOptions ?? resolveLaunchOptions(nextRequest, nextProfile, {}),
    onProgress: overrides.onProgress ?? (() => {}),
  };
};

const spawnedRunner = (child = new FakeChildProcess(), fileExists?: (path: string) => boolean) => {
  let command = "";
  let args: string[] = [];
  let spawnOptions: unknown;
  const runner = new PiProcessRunner({
    spawnProcess(nextCommand, nextArgs, nextOptions) {
      command = nextCommand;
      args = [...nextArgs];
      spawnOptions = nextOptions;
      return child;
    },
    ...(fileExists ? { fileExists } : {}),
  });

  return {
    child,
    runner,
    invocation: () => ({ command, args, spawnOptions }),
  };
};

const argumentValue = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const assertIsolatedInvocation = (args: readonly string[]): void => {
  assert.equal(
    args.filter((argument) => argument === "--no-extensions").length,
    1,
  );
  assert.equal(args.includes("--extension"), false);
  assert.equal(args.includes("-e"), false);
};

test("launches Pi without a shell using the current script and generic read-only tools", async () => {
  const { child, runner, invocation } = spawnedRunner();

  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ name: "generic", source: "builtin", tools: ["bash"] }),
    onProgress() {},
  }));
  const actual = invocation();

  assert.equal(actual.command, process.execPath);
  assert.deepEqual(actual.args.slice(0, 6), [
    process.argv[1],
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
  ]);
  assertIsolatedInvocation(actual.args);
  assert.equal(argumentValue(actual.args, "--tools"), "read,grep,find,ls");
  assert.equal(actual.args.at(-1), "Inspect the repository");
  assert.deepEqual(actual.spawnOptions, {
    cwd: "/workspace",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.close();
  await running.result;
});

test("falls back to the pi command when the current script is unavailable", async () => {
  const originalScript = process.argv[1] ?? "";
  process.argv[1] = "/missing/pi-script.mjs";

  try {
    const { child, runner, invocation } = spawnedRunner();
    const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

    assert.equal(invocation().command, "pi");
    child.close();
    await running.result;
  } finally {
    process.argv[1] = originalScript;
  }
});

test("falls back to the pi command for a Bun virtual current script", async () => {
  const originalScript = process.argv[1] ?? "";
  process.argv[1] = "/$bunfs/root/pi-script.mjs";

  try {
    const { child, runner, invocation } = spawnedRunner(new FakeChildProcess(), (path) => path === process.argv[1]);
    const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

    assert.equal(invocation().command, "pi");
    child.close();
    await running.result;
  } finally {
    process.argv[1] = originalScript;
  }
});

test("passes inherited thinking separately with child extension isolation", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const legacyProfile = profile({ systemPrompt: "" });
  const legacyRequest = request();
  const running = runner.run(runOptions({
    request: legacyRequest,
    profile: legacyProfile,
    launchOptions: resolveLaunchOptions(legacyRequest, legacyProfile, { parentModel: "ollama/llama3.1:8b", thinkingLevel: "high" }),
  }));

  assert.deepEqual(invocation().args, [
    process.argv[1],
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--model",
    "ollama/llama3.1:8b",
    "--thinking",
    "high",
    "--no-tools",
    "Inspect the repository",
  ]);
  assert.equal(invocation().args.includes("ollama/llama3.1:8b:high"), false);
  assertIsolatedInvocation(invocation().args);
  child.close();
  await running.result;
});

test("passes opaque override model and explicit thinking as separate arguments", async () => {
  for (const model of ["anthropic/sonnet:high", "ollama/llama3.1:8b", "vendor/model:real:high"]) {
    const { child, runner, invocation } = spawnedRunner();
    const nextRequest = request();
    const nextProfile = profile({ systemPrompt: "", tools: ["read", "bash"] });
    const running = runner.run(runOptions({
      request: nextRequest,
      profile: nextProfile,
      launchOptions: {
        modelArgument: model,
        thinkingArgument: "low",
        launchModel: model,
        launchThinkingLevel: "low",
        launchThinkingSource: "job",
        diagnostics: [],
      },
    }));

    assert.equal(argumentValue(invocation().args, "--model"), model);
    assert.equal(argumentValue(invocation().args, "--thinking"), "low");
    assert.equal(argumentValue(invocation().args, "--tools"), "read");
    assertIsolatedInvocation(invocation().args);
    child.close();
    await running.result;
  }
});

test("passes thinking without model when child Pi must select its default", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run(runOptions({
    launchOptions: {
      modelArgument: undefined,
      thinkingArgument: "max",
      launchModel: undefined,
      launchThinkingLevel: "max",
      launchThinkingSource: "job",
      diagnostics: [],
    },
  }));

  assert.equal(argumentValue(invocation().args, "--model"), undefined);
  assert.equal(argumentValue(invocation().args, "--thinking"), "max");
  assertIsolatedInvocation(invocation().args);
  child.close();
  await running.result;
});

test("intersects named read-only profile tools with the read-only permission set", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ tools: ["bash", "read", "edit", "write", "unknown"] }),
    onProgress() {},
  }));

  assert.equal(argumentValue(invocation().args, "--tools"), "read");
  assertIsolatedInvocation(invocation().args);
  child.close();
  await running.result;
});

test("disables Pi default tools for a named profile without a tools list", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ tools: undefined }),
    onProgress() {},
  }));

  assert.ok(invocation().args.includes("--no-tools"));
  assert.equal(argumentValue(invocation().args, "--tools"), undefined);
  child.close();
  await running.result;
});

test("disables Pi default tools when a named read-only profile requests only bash", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ tools: ["bash"] }),
    onProgress() {},
  }));

  assert.ok(invocation().args.includes("--no-tools"));
  assert.equal(argumentValue(invocation().args, "--tools"), undefined);
  child.close();
  await running.result;
});

test("permits requested write tools for writable named profiles", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const selected = profile({ tools: ["write", "bash", "read", "edit", "read", "unknown"] });
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(true),
    profile: selected,
    onProgress() {},
  }));

  assert.equal(
    argumentValue(invocation().args, "--tools"),
    getLaunchToolAllowlist(selected, "write").join(","),
  );
  assert.equal(argumentValue(invocation().args, "--tools"), "read,bash,edit,write");
  assertIsolatedInvocation(invocation().args);
  child.close();
  await running.result;
});

test("passes a private temporary system prompt file and removes it after close", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run(runOptions({
    cwd: "/workspace",
    request: request(),
    profile: profile({ systemPrompt: "Only report verified findings." }),
    onProgress() {},
  }));
  const promptPath = argumentValue(invocation().args, "--append-system-prompt");

  assert.ok(promptPath);
  assert.equal(readFileSync(promptPath, "utf8"), "Only report verified findings.");
  assert.equal(statSync(promptPath).mode & 0o777, 0o600);

  child.close();
  await running.result;
  assert.equal(existsSync(promptPath), false);
});

test("reduces split assistant events into final output and accumulated usage", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) }));

  child.stdout.emit("data", Buffer.from('{"type":"tool_execution_start","toolName":"read"}\n'));
  child.stdout.emit("data", Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Final answer"}],"usage":{"input":3,"output":5,"cacheRead":7,"cacheWrite":11,"cost":{"total":0.25}},"model":"openai/gpt-5","stopReason":"stop"'));
  child.stdout.emit("data", Buffer.from(',"errorMessage":""}}'));
  child.stderr.emit("data", Buffer.from("warning from Pi"));
  child.close(0);

  const result = await running.result;
  assert.equal(result.output, "Final answer");
  assert.deepEqual(result.usage, { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 0.25, turns: 1 });
  assert.equal(result.model, "openai/gpt-5");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.stderr, "warning from Pi");
  assert.equal(result.malformedEventCount, 0);
  assert.equal(progress.length, 1);
  assert.equal(progress[0]?.type, "tool");
  assert.match(progress[0]?.text ?? "", /read/);
});

test("reduces split Pi text_delta updates into bounded latest text progress", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) }));

  child.stdout.emit("data", Buffer.from('{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"Hel'));
  child.stdout.emit("data", Buffer.from('lo"}}\n{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":" world"}}\n'));

  assert.deepEqual(progress.map((item) => [item.type, item.text]), [["text", "Hello"], ["text", "Hello world"]]);
  child.close();
  await running.result;
});

test("emits fixed turn and throttled reasoning activity without exposing reasoning text", async () => {
  const child = new FakeChildProcess();
  const progress: ProgressItem[] = [];
  let now = 1_000;
  const runner = new PiProcessRunner({
    now: () => now,
    spawnProcess: () => child,
  });
  const running = runner.run(runOptions({ onProgress: (item) => progress.push(item) }));
  const emit = (event: unknown): void => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  };

  emit({ type: "turn_start" });
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_start", content: "SECRET_START" },
  });
  now = 5_999;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "SECRET_EARLY" },
  });
  now = 6_000;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "SECRET_BOUNDARY" },
  });
  now = 10_999;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "SECRET_BEFORE_SECOND_HEARTBEAT" },
  });
  now = 11_000;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "SECRET_SECOND_HEARTBEAT" },
  });
  now = 11_001;
  emit({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_end", content: "SECRET_END" },
  });
  emit({ type: "turn_end" });

  assert.deepEqual(
    progress.map(({ type, text, timestamp }) => [type, text, timestamp]),
    [
      ["model", "Model turn started", 1_000],
      ["model", "Model reasoning", 1_000],
      ["model", "Model reasoning", 6_000],
      ["model", "Model reasoning", 11_000],
      ["model", "Model reasoning finished", 11_001],
      ["model", "Model turn finished", 11_001],
    ],
  );
  assert.doesNotMatch(JSON.stringify(progress), /SECRET_/u);

  child.close();
  await running.result;
});

test("handles split reasoning events and resets heartbeat state at turn boundaries", async () => {
  const child = new FakeChildProcess();
  const progress: ProgressItem[] = [];
  let now = 10_000;
  const runner = new PiProcessRunner({
    now: () => now,
    spawnProcess: () => child,
  });
  const running = runner.run(runOptions({ onProgress: (item) => progress.push(item) }));

  const start = JSON.stringify({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_start", content: "PRIVATE" },
  });
  child.stdout.emit("data", Buffer.from(start.slice(0, 30)));
  child.stdout.emit("data", Buffer.from(`${start.slice(30)}\n`));
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", message: null, assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE" } })}\n`));
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", message: { role: "user" }, assistantMessageEvent: { type: "thinking_end", content: "PRIVATE" } })}\n`));
  child.stdout.emit("data", Buffer.from('{"type":"turn_end"}\n{"type":"turn_start"}\n'));
  now = 10_001;
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_AFTER_RESET" },
  })}\n`));

  assert.deepEqual(progress.map((item) => item.text), [
    "Model reasoning",
    "Model turn finished",
    "Model turn started",
    "Model reasoning",
  ]);
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE/u);

  child.close();
  await running.result;
});

test("records cumulative partial metadata across multibyte deltas and resets it for the next assistant message", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) }));
  const firstDelta = "😀".repeat(12_800);
  const secondDelta = "😀".repeat(100);

  for (const delta of [firstDelta, secondDelta]) {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta } })}\n`));
  }

  const latest = progress.at(-1);
  assert.ok(latest);
  assert.ok(Buffer.byteLength(latest.text, "utf8") <= CAPTURED_TEXT_MAX_BYTES);
  assert.deepEqual(latest.truncation, {
    originalBytes: Buffer.byteLength(firstDelta + secondDelta, "utf8"),
    keptBytes: Buffer.byteLength(latest.text, "utf8"),
  });

  child.stdout.emit("data", Buffer.from('{"type":"message_start","message":{"role":"assistant"}}\n'));
  child.stdout.emit("data", Buffer.from('{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"new"}}\n'));
  assert.deepEqual(progress.at(-1), { type: "text", text: "new", timestamp: progress.at(-1)?.timestamp, truncation: undefined });
  child.close();
  await running.result;
});

test("keeps a UTF-8-safe partial prefix after a multibyte truncation boundary", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) }));
  const expected = "a".repeat(CAPTURED_TEXT_MAX_BYTES - 1);
  const first = expected + "😀";
  const second = "x";

  for (const delta of [first, second]) {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta } })}\n`));
  }

  const latest = progress.at(-1);
  assert.ok(latest);
  assert.equal(latest.text, expected);
  assert.equal(latest.text.includes(second), false);
  assert.ok(Buffer.byteLength(latest.text, "utf8") <= CAPTURED_TEXT_MAX_BYTES);
  assert.deepEqual(latest.truncation, {
    originalBytes: Buffer.byteLength(first + second, "utf8"),
    keptBytes: Buffer.byteLength(expected, "utf8"),
  });

  child.close();
  await running.result;
});

test("resets partial text when a new assistant message starts", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) }));

  child.stdout.emit("data", Buffer.from('{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"old"}}\n'));
  child.stdout.emit("data", Buffer.from('{"type":"message_start","message":{"role":"assistant"}}\n'));
  child.stdout.emit("data", Buffer.from('{"type":"message_update","message":{"role":"assistant"},"assistantMessageEvent":{"type":"text_delta","delta":"new"}}\n'));

  assert.deepEqual(progress.map((item) => item.text), ["old", "", "new"]);
  child.close();
  await running.result;
});

test("streams every documented tool event through progress without retaining a capped history", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) }));

  for (let index = 0; index < 201; index += 1) {
    child.stdout.emit("data", Buffer.from(`{"type":"tool_execution_start","toolName":"read-${index}"}\n`));
  }
  child.stdout.emit("data", Buffer.from('{"type":"tool_execution_update","toolName":"read-0"}\n{"type":"tool_execution_end","toolName":"read-0"}\n{"type":"tool_result_end","message":{"role":"toolResult","content":[]}}\n'));
  child.close();

  await running.result;
  assert.equal(progress.length, 204);
  assert.match(progress.at(-1)?.text ?? "", /result/i);
});

test("resolves a spawn error as a failed result", async () => {
  const child = new FakeChildProcess();
  const runner = new PiProcessRunner({
    spawnProcess() {
      return child;
    },
  });
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  child.emit("error", new Error("pi missing"));
  const result = await running.result;
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "pi missing");
});

test("records assistant error metadata when capture truncates", async () => {
  const { child, runner } = spawnedRunner();
  const errorText = "😀".repeat(13_000);
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], errorMessage: errorText } })}\n`));
  child.close(1);

  const result = await running.result;
  assert.ok(Buffer.byteLength(result.errorMessage ?? "", "utf8") <= CAPTURED_TEXT_MAX_BYTES);
  assert.deepEqual(result.errorTruncation, {
    originalBytes: Buffer.byteLength(errorText, "utf8"),
    keptBytes: Buffer.byteLength(result.errorMessage ?? "", "utf8"),
  });
});

test("clears error metadata when a later assistant error fits capture", async () => {
  const { child, runner } = spawnedRunner();
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  for (const errorMessage of ["😀".repeat(13_000), "later error"]) {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], errorMessage } })}\n`));
  }
  child.close(1);

  const result = await running.result;
  assert.equal(result.errorMessage, "later error");
  assert.equal(result.errorTruncation, undefined);
});

test("records spawn error metadata when capture truncates", async () => {
  const child = new FakeChildProcess();
  const runner = new PiProcessRunner({ spawnProcess: () => child });
  const errorText = "😀".repeat(13_000);
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  child.emit("error", new Error(errorText));
  const result = await running.result;
  assert.deepEqual(result.errorTruncation, {
    originalBytes: Buffer.byteLength(errorText, "utf8"),
    keptBytes: Buffer.byteLength(result.errorMessage ?? "", "utf8"),
  });
});

test("fails a child closed by an external signal even after assistant output", async () => {
  const { child, runner } = spawnedRunner();
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  child.stdout.emit("data", Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"partial answer"}]}}\n'));
  child.close(null, "SIGTERM");

  const result = await running.result;
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.output, "partial answer");
});

test("settles error and close exactly once while cleaning listeners and cancellation timer", async () => {
  const child = new FakeChildProcess();
  const cleared: unknown[] = [];
  const runner = new PiProcessRunner({
    spawnProcess: () => child,
    setTimer: () => "timer",
    clearTimer: (timer) => { cleared.push(timer); },
  });
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  await running.cancel();
  child.emit("error", new Error("spawn failed"));
  child.close(0);
  const result = await running.result;

  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "spawn failed");
  assert.deepEqual(cleared, ["timer"]);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
});

test("bounds captured output, stderr, assistant errors, and malformed samples before returning a result", async () => {
  const { child, runner } = spawnedRunner();
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));
  const oversized = "😀".repeat(15_000);

  child.stdout.emit("data", Buffer.from(`not-json-${oversized}\n`));
  child.stdout.emit("data", Buffer.from(`${JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: oversized }], errorMessage: oversized },
  })}\n`));
  child.stderr.emit("data", Buffer.from(oversized));
  child.close(1);

  const result = await running.result;
  for (const text of [result.output, result.stderr, result.errorMessage ?? "", ...(result.malformedEventSamples ?? [])]) {
    assert.ok(Buffer.byteLength(text, "utf8") <= 50 * 1024);
    assert.doesNotMatch(text, /\uFFFD/);
  }
  assert.ok(result.outputTruncation);
  assert.ok(result.stderrTruncation);
  assert.ok((result.malformedEventSamples?.length ?? 0) > 0);
});

test("cancellation sends SIGTERM then SIGKILL after five seconds unless the process closes", async () => {
  const child = new FakeChildProcess();
  let scheduledDelay: number | undefined;
  let escalation: (() => void) | undefined;
  const runner = new PiProcessRunner({
    spawnProcess() {
      return child;
    },
    setTimer(callback, delay) {
      scheduledDelay = delay;
      escalation = callback;
      return "timer";
    },
    clearTimer() {},
  });
  const running = runner.run(runOptions({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} }));

  await running.cancel();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(scheduledDelay, 5_000);
  escalation?.();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);

  child.close(143);
  assert.equal((await running.result).exitCode, 143);
});
