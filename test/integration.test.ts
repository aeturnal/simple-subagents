import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverAgents } from "../src/agents.ts";
import { PiProcessRunner, type SpawnOptions, type SpawnedProcess } from "../src/process-runner.ts";

const integrationTest = process.env.SIMPLE_SUBAGENTS_INTEGRATION === "1" ? test : test.skip;


integrationTest("real Pi reads a file with the generic read-only profile", { timeout: 120_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "simple-subagents-integration-"));
  const answer = "simple-subagents integration answer";
  let invocation: { command: string; args: string[] } | undefined;
  let running: ReturnType<PiProcessRunner["run"]> | undefined;
  let settled = false;

  t.after(async () => {
    if (running && !settled) {
      await running.cancel();
      await running.result;
    }
    await rm(cwd, { recursive: true, force: true });
  });

  await writeFile(join(cwd, "answer.txt"), answer);
  const profiles = await discoverAgents(join(cwd, "agents"));
  const generic = profiles.agents.find((profile) => profile.name === "generic");
  assert.ok(generic);

  const runner = new PiProcessRunner({
    fileExists: () => false,
    spawnProcess(command: string, args: readonly string[], options: SpawnOptions): SpawnedProcess {
      invocation = { command, args: [...args] };
      return spawn(command, args, options) as unknown as SpawnedProcess;
    },
  });
  running = runner.run({
    cwd,
    request: {
      task: "Read answer.txt and return its exact contents.",
      agent: "generic",
      writeAccess: false,
    },
    profile: generic,
    onProgress() {},
  });
  void running.result.then(() => {
    settled = true;
  });

  assert.ok(invocation);
  assert.equal(invocation.command, "pi");
  const enabledTools = invocation.args[invocation.args.indexOf("--tools") + 1]?.split(",") ?? [];
  assert.ok(invocation.args.includes("--tools"));
  assert.equal(enabledTools.includes("bash"), false);
  assert.equal(enabledTools.includes("edit"), false);
  assert.equal(enabledTools.includes("write"), false);

  const result = await running.result;
  assert.equal(result.exitCode, 0);
  assert.notEqual(result.output, "");
  assert.equal(result.output, answer, `Pi output: ${JSON.stringify(result.output)}\nPi stderr: ${result.stderr}`);
});
