import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { PiProcessRunner } from "../src/process-runner.ts";
import type { AgentProfile, JobRequest, ProgressItem } from "../src/types.ts";

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  close(code: number | null = 0): void {
    this.emit("close", code);
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

test("launches Pi without a shell using the current script and generic read-only tools", async () => {
  const { child, runner, invocation } = spawnedRunner();

  const running = runner.run({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ name: "generic", source: "builtin", tools: ["bash"] }),
    onProgress() {},
  });
  const actual = invocation();

  assert.equal(actual.command, process.execPath);
  assert.deepEqual(actual.args.slice(0, 5), [process.argv[1], "--mode", "json", "-p", "--no-session"]);
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
    const running = runner.run({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} });

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
    const running = runner.run({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} });

    assert.equal(invocation().command, "pi");
    child.close();
    await running.result;
  } finally {
    process.argv[1] = originalScript;
  }
});

test("adds inherited thinking to the selected model but preserves an explicit profile suffix", async () => {
  const inherited = spawnedRunner();
  const inheritedRun = inherited.runner.run({
    cwd: "/workspace",
    request: request(),
    profile: profile({ systemPrompt: "" }),
    parentModel: "openai/gpt-5",
    thinkingLevel: "high",
    onProgress() {},
  });
  assert.equal(argumentValue(inherited.invocation().args, "--model"), "openai/gpt-5:high");
  inherited.child.close();
  await inheritedRun.result;

  const explicit = spawnedRunner();
  const explicitRun = explicit.runner.run({
    cwd: "/workspace",
    request: request(),
    profile: profile({ model: "anthropic/sonnet:low", systemPrompt: "" }),
    parentModel: "openai/gpt-5",
    thinkingLevel: "high",
    onProgress() {},
  });
  assert.equal(argumentValue(explicit.invocation().args, "--model"), "anthropic/sonnet:low");
  explicit.child.close();
  await explicitRun.result;
});

test("adds inherited thinking after a colon-bearing model identifier", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run({
    cwd: "/workspace",
    request: request(),
    profile: profile({ systemPrompt: "" }),
    parentModel: "ollama/llama3.1:8b",
    thinkingLevel: "high",
    onProgress() {},
  });

  assert.equal(argumentValue(invocation().args, "--model"), "ollama/llama3.1:8b:high");
  child.close();
  await running.result;
});

test("intersects named read-only profile tools with the read-only permission set", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ tools: ["bash", "read", "edit", "write", "unknown"] }),
    onProgress() {},
  });

  assert.equal(argumentValue(invocation().args, "--tools"), "read");
  child.close();
  await running.result;
});

test("disables Pi default tools for a named profile without a tools list", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ tools: undefined }),
    onProgress() {},
  });

  assert.ok(invocation().args.includes("--no-tools"));
  assert.equal(argumentValue(invocation().args, "--tools"), undefined);
  child.close();
  await running.result;
});

test("disables Pi default tools when a named read-only profile requests only bash", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run({
    cwd: "/workspace",
    request: request(false),
    profile: profile({ tools: ["bash"] }),
    onProgress() {},
  });

  assert.ok(invocation().args.includes("--no-tools"));
  assert.equal(argumentValue(invocation().args, "--tools"), undefined);
  child.close();
  await running.result;
});

test("permits requested write tools for writable named profiles", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run({
    cwd: "/workspace",
    request: request(true),
    profile: profile({ tools: ["bash", "read", "edit", "write", "unknown"] }),
    onProgress() {},
  });

  assert.equal(argumentValue(invocation().args, "--tools"), "bash,read,edit,write");
  child.close();
  await running.result;
});

test("passes a private temporary system prompt file and removes it after close", async () => {
  const { child, runner, invocation } = spawnedRunner();
  const running = runner.run({
    cwd: "/workspace",
    request: request(),
    profile: profile({ systemPrompt: "Only report verified findings." }),
    onProgress() {},
  });
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
  const running = runner.run({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) });

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

test("streams every documented tool event through progress without retaining a capped history", async () => {
  const { child, runner } = spawnedRunner();
  const progress: ProgressItem[] = [];
  const running = runner.run({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress: (item) => progress.push(item) });

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
  const running = runner.run({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} });

  child.emit("error", new Error("pi missing"));
  const result = await running.result;
  assert.equal(result.exitCode, 1);
  assert.equal(result.errorMessage, "pi missing");
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
  const running = runner.run({ cwd: "/workspace", request: request(), profile: profile({ systemPrompt: "" }), onProgress() {} });

  await running.cancel();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(scheduledDelay, 5_000);
  escalation?.();
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);

  child.close(143);
  assert.equal((await running.result).exitCode, 143);
});
