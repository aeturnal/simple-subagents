import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { discoverAgents } from "../src/agents.js";

test("missing config falls back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");

  const result = await loadConfig(configPath);

  assert.deepEqual(result.config, { confirmWrites: false });
  assert.equal(result.warning, undefined);
});

test("valid confirmWrites is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, JSON.stringify({ confirmWrites: true }));

  const result = await loadConfig(configPath);

  assert.deepEqual(result.config, { confirmWrites: true });
  assert.equal(result.warning, undefined);
});

test("invalid confirmWrites fails safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, JSON.stringify({ confirmWrites: "no" }));

  const result = await loadConfig(configPath);

  assert.equal(result.config.confirmWrites, true);
  assert.match(result.warning ?? "", /confirmWrites/);
});

test("invalid json fails safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, "{");

  const result = await loadConfig(configPath);

  assert.equal(result.config.confirmWrites, true);
  assert.match(result.warning ?? "", /JSON/);
});

test("discovers generic and user markdown profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  await writeFile(join(agentsDir, "reviewer.md"), `---\nname: reviewer\ndescription: Reviews code\ntools: read, grep\n---\nReturn line-referenced findings.\n`);

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "reviewer"]);
  assert.deepEqual(result.agents[1]?.tools, ["read", "grep"]);
  assert.equal(result.agents[1]?.systemPrompt, "Return line-referenced findings.");
});

test("keeps the first duplicate profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  await writeFile(join(agentsDir, "a.md"), `---\nname: reviewer\ndescription: First\n---\nA\n`);
  await writeFile(join(agentsDir, "b.md"), `---\nname: reviewer\ndescription: Second\n---\nB\n`);

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.description), ["Generic coding agent", "First"]);
  assert.equal(result.diagnostics.some((note) => /duplicate/i.test(note)), true);
});

test("excludes project profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  await writeFile(join(agentsDir, "project.md"), `---\nname: project-reviewer\ndescription: Ignore me\nsource: project\n---\n`);
  await writeFile(join(agentsDir, "user.md"), `---\nname: user-reviewer\ndescription: Keep me\n---\n`);

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "user-reviewer"]);
  assert.equal(result.diagnostics.some((note) => /project/i.test(note)), true);
});
