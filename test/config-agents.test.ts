import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { discoverAgents } from "../src/agents.js";
import { THINKING_LEVELS } from "../src/types.js";

test("missing config falls back safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");

  const result = await loadConfig(configPath);

  assert.deepEqual(result.config, { confirmWrites: false });
  assert.equal(result.warning, undefined);
});

test("config read failures other than missing file fail safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await mkdir(configPath);

  const result = await loadConfig(configPath);

  assert.equal(result.config.confirmWrites, true);
  assert.match(result.warning ?? "", /read|config/i);
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
  await writeFile(join(agentsDir, "reviewer.md"), `---\nname: reviewer\ndescription: Reviews code\ntools: read, grep\nmodel: openai-codex/gpt-5.6-sol\nthinking: medium\n---\nReturn line-referenced findings.\n`);

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "reviewer"]);
  assert.deepEqual(result.agents[1]?.tools, ["read", "grep"]);
  assert.equal(result.agents[1]?.model, "openai-codex/gpt-5.6-sol");
  assert.equal(result.agents[1]?.thinking, "medium");
  assert.equal(result.agents[1]?.systemPrompt, "Return line-referenced findings.");
});

test("preserves every valid profile thinking level", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);

  for (const thinking of THINKING_LEVELS) {
    await writeFile(
      join(agentsDir, `thinking-${thinking}.md`),
      `---\nname: ${thinking}\ndescription: ${thinking} profile\nthinking: ${thinking}\n---\n`,
    );
  }

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.slice(1).map((agent) => agent.thinking).sort(), [...THINKING_LEVELS].sort());
});

test("skips profiles with invalid thinking and continues discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  const invalidProfiles = [
    ["invalid-medium-spaces", '" medium "'],
    ["invalid-medium-uppercase", "MEDIUM"],
    ["invalid-number", "1"],
    ["invalid-ultra", "ultra"],
  ] as const;

  for (const [name, thinking] of invalidProfiles) {
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Invalid thinking\nthinking: ${thinking}\n---\n`,
    );
  }
  await writeFile(join(agentsDir, "valid.md"), `---\nname: valid\ndescription: Valid thinking\nthinking: high\n---\n`);

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "valid"]);
  for (const [name] of invalidProfiles) {
    const diagnostic = result.diagnostics.find((note) => note.includes(`${name}.md`));
    assert.match(diagnostic ?? "", /thinking/);
    assert.match(diagnostic ?? "", /off, minimal, low, medium, high, xhigh, max/);
  }
});

test("skips model thinking suffixes and keeps ordinary colon models", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  await writeFile(
    join(agentsDir, "reserved.md"),
    `---\nname: reserved\ndescription: Reserved suffix\nmodel: openai-codex/gpt-5.6-sol:high\n---\n`,
  );
  await writeFile(
    join(agentsDir, "valid.md"),
    `---\nname: valid\ndescription: Ordinary colon model\nmodel: ollama/llama3.1:8b\n---\n`,
  );

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "valid"]);
  assert.equal(result.agents[1]?.model, "ollama/llama3.1:8b");
  const diagnostic = result.diagnostics.find((note) => note.includes("reserved.md"));
  assert.match(diagnostic ?? "", /:high/);
  assert.match(diagnostic ?? "", /thinking: high/);
});

test("agents directory read failures return a diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await writeFile(agentsDir, "not a directory");

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic"]);
  assert.equal(result.diagnostics.length > 0, true);
  assert.match(result.diagnostics[0] ?? "", /agent|read|directory/i);
});

test("malformed frontmatter does not stop later profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-agents-"));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir);
  await writeFile(join(agentsDir, "bad.md"), `---\nname: [\n---\nBroken\n`);
  await writeFile(join(agentsDir, "good.md"), `---\nname: reviewer\ndescription: Keep going\n---\nReturn line-referenced findings.\n`);

  const result = await discoverAgents(agentsDir);

  assert.deepEqual(result.agents.map((agent) => agent.name), ["generic", "reviewer"]);
  assert.equal(result.diagnostics.some((note) => /frontmatter|yaml|parse/i.test(note)), true);
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

test("entrypoint exports a function", async () => {
  const mod = await import("../src/index.ts");

  assert.equal(typeof mod.default, "function");
});
