# Project Agent Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `subagent_agents` and `subagent_start` discover user profiles, nearest-project profiles, or both, with safe precedence, confirmation, diagnostics, and documentation.

**Architecture:** Replace the session-wide profile map with one deep scoped-discovery module called by both tools. Directory origin assigns each profile's trusted source; the discovery layer owns nearest-project lookup, merge precedence, reserved names, and bounded diagnostics, while the tool/runtime layer owns call scope and launch confirmation.

**Tech Stack:** TypeScript 5.9, Node.js 22.19, TypeBox, Node test runner through `tsx`.

## Global Constraints

- Keep the existing agent Markdown schema unchanged: YAML frontmatter with `name`, `description`, optional `tools`, optional `model`, followed by the system prompt.
- Support only `agentScope: "user" | "project" | "both"`; default omitted scope to `user`.
- Resolve project discovery from the parent tool context's `ctx.cwd`; never use a task-level `cwd` for profile discovery.
- Find the nearest ancestor `.pi/agents/` directory and stop at the filesystem root.
- Keep built-in `generic` first and unreplaceable.
- In `both`, project profiles replace same-named user profiles without a duplicate warning.
- Within one source, alphabetical file order wins duplicate names and emits a bounded diagnostic.
- Treat missing user or project profile directories as normal, not errors.
- Never expose system prompts, full file paths, raw frontmatter, or parser internals in public tool output.
- Ask once for every batch that resolves at least one project profile; decline or missing interactive UI rejects the complete batch before enqueue.
- Keep writable confirmation separate from project-profile confirmation.
- Add user-controlled `confirmProjectAgents` in `~/.pi/agent/simple-subagents.json`, defaulting to `true`; no tool input may disable it.
- Preserve all background start, status, wait, cancel, collect, discard, and dashboard behavior.
- Describe compatibility as Pi's bundled subagent example, not an official standard.

---

### Task 1: Add scope and secure configuration types

**Files:**

- Modify: `src/types.ts:3-22`
- Modify: `src/config.ts:1-56`
- Test: `test/config-agents.test.ts:1-63`
- Modify: `test/tools.test.ts:700-980` (typed config fixtures only)

**Interfaces:**

- Produces: `AgentScope`, `ProfileSource`, `AGENT_SCOPES`, and `SimpleSubagentsConfig.confirmProjectAgents: boolean`.
- Produces: `loadConfig(path)` defaults of `{ confirmWrites: false, confirmProjectAgents: true }` for a missing or partial valid config.
- Consumes: No new interfaces from later tasks.

- [ ] **Step 1: Write failing type and configuration tests**

In `test/config-agents.test.ts`, update every existing expected config object to include `confirmProjectAgents`. Add these focused tests:

```ts
test("confirmProjectAgents defaults on for a missing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const result = await loadConfig(join(root, "simple-subagents.json"));

  assert.deepEqual(result.config, {
    confirmWrites: false,
    confirmProjectAgents: true,
  });
});

test("valid project confirmation configuration is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, JSON.stringify({
    confirmWrites: true,
    confirmProjectAgents: false,
  }));

  const result = await loadConfig(configPath);

  assert.deepEqual(result.config, {
    confirmWrites: true,
    confirmProjectAgents: false,
  });
  assert.equal(result.warning, undefined);
});

test("invalid project confirmation configuration fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "simple-subagents-config-"));
  const configPath = join(root, "simple-subagents.json");
  await writeFile(configPath, JSON.stringify({ confirmProjectAgents: "no" }));

  const result = await loadConfig(configPath);

  assert.equal(result.config.confirmProjectAgents, true);
  assert.match(result.warning ?? "", /confirmProjectAgents/);
});
```

For existing read-error, invalid-JSON, and invalid-object tests, assert that both confirmation flags fail closed to `true`. For a valid object missing one property, preserve the existing `confirmWrites: false` default and use `confirmProjectAgents: true`.

In `test/tools.test.ts`, add `confirmProjectAgents: true` to every typed `loadConfig` fixture. This is a compile-only fixture update; project-confirmation behavior remains for Task 5.

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='config|confirmProjectAgents' test/config-agents.test.ts
```

Expected: failures show `confirmProjectAgents` is absent from `SimpleSubagentsConfig` or loaded config values.

- [ ] **Step 3: Add exact shared scope and source types**

In `src/types.ts`, replace the existing config and inline source union with:

```ts
export const AGENT_SCOPES = ["user", "project", "both"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];
export type ProfileSource = "builtin" | "user" | "project";

export interface SimpleSubagentsConfig {
  confirmWrites: boolean;
  confirmProjectAgents: boolean;
}
```

Set `AgentProfile.source` to `ProfileSource`.

- [ ] **Step 4: Implement independent, fail-closed config parsing**

In `src/config.ts`, define these defaults:

```ts
const DEFAULT_CONFIG: SimpleSubagentsConfig = {
  confirmWrites: false,
  confirmProjectAgents: true,
};

const FAIL_CLOSED_CONFIG: SimpleSubagentsConfig = {
  confirmWrites: true,
  confirmProjectAgents: true,
};
```

Keep missing-file behavior on `DEFAULT_CONFIG`. Keep read failures, invalid JSON, and non-object input on `FAIL_CLOSED_CONFIG`. For a valid object, validate `confirmWrites` and `confirmProjectAgents` independently: an omitted property uses its default; a non-boolean property uses its fail-closed value and adds its exact property name to the single warning. Return a fresh config object rather than either shared constant.

- [ ] **Step 5: Run configuration tests and type checking**

Run:

```bash
npx tsx --test --test-name-pattern='config|confirmProjectAgents' test/config-agents.test.ts
npm run typecheck
```

Expected: all selected tests and TypeScript checks pass.

- [ ] **Step 6: Commit the configuration contract**

```bash
git add src/types.ts src/config.ts test/config-agents.test.ts test/tools.test.ts
git commit -m "feat: add project agent confirmation config"
```

---

### Task 2: Build scoped profile discovery and precedence

**Files:**

- Modify: `src/agents.ts:1-136`
- Test: `test/config-agents.test.ts:64-190`
- Verify: `test/integration.test.ts`

**Interfaces:**

- Consumes: `AgentScope` and `ProfileSource` from Task 1.
- Produces: the small external discovery seam `DiscoverScopedAgentsOptions` and `discoverScopedAgents(options)`.
- Keeps internal: `findNearestProjectAgentsDir(startCwd)`; nearest-walk behavior is tested through `discoverScopedAgents` so callers do not learn an extra interface.
- Preserves: `discoverAgents(agentsDir)` as the default-user compatibility wrapper used by integration tests.

- [ ] **Step 1: Replace the old exclusion test with failing scope tests**

Remove `excludes project profiles`; source is now trusted directory metadata, not a public frontmatter selector. Add helpers and tests in `test/config-agents.test.ts` that create this tree:

```text
<root>/user-agents/a-user.md                     name: reviewer, description: User reviewer
<root>/user-agents/b-user-helper.md              name: user-helper
<root>/.pi/agents/root.md                        name: root-agent
<root>/packages/app/.pi/agents/a-project.md      name: reviewer, description: Project reviewer
<root>/packages/app/.pi/agents/b-project-helper.md name: project-helper
<root>/packages/app/src/                      parent cwd
```

Add separate tests asserting:

```ts
const user = await discoverScopedAgents({
  agentScope: "user",
  userAgentsDir,
  parentCwd,
});
assert.deepEqual(user.agents.map(({ name, source }) => ({ name, source })), [
  { name: "generic", source: "builtin" },
  { name: "reviewer", source: "user" },
  { name: "user-helper", source: "user" },
]);

const project = await discoverScopedAgents({
  agentScope: "project",
  userAgentsDir,
  parentCwd,
});
assert.deepEqual(project.agents.map(({ name, source }) => ({ name, source })), [
  { name: "generic", source: "builtin" },
  { name: "reviewer", source: "project" },
  { name: "project-helper", source: "project" },
]);

const both = await discoverScopedAgents({
  agentScope: "both",
  userAgentsDir,
  parentCwd,
});
assert.equal(both.agents[0]?.name, "generic");
assert.equal(both.agents.find((entry) => entry.name === "reviewer")?.description, "Project reviewer");
assert.equal(both.agents.some((entry) => entry.name === "user-helper"), true);
assert.equal(both.agents.some((entry) => entry.name === "project-helper"), true);
assert.equal(both.diagnostics.some((entry) => /duplicate.*reviewer/i.test(entry)), false);
```

The `project` assertion must prove nearest lookup chooses `packages/app/.pi/agents/`, not the root `.pi/agents/`. Also add tests for:

- Missing user and project directories return only `generic` with no diagnostics.
- A profile named `generic` in either source never replaces the built-in and emits a reserved-name diagnostic.
- Duplicate files inside one source keep alphabetically first content and emit one duplicate diagnostic.
- Malformed files do not stop valid later files.
- More than 20 malformed or duplicate files produce at most 20 finding records plus one omission record, with every record at most 512 UTF-8 bytes.
- Returned project profiles have `source: "project"` and their real private `filePath` only inside `AgentProfile`.

- [ ] **Step 2: Run scoped discovery tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='scope|nearest|reserved|duplicate|malformed|missing' test/config-agents.test.ts
```

Expected: `discoverScopedAgents` and `findNearestProjectAgentsDir` are missing, or project profiles are not discovered.

- [ ] **Step 3: Split directory loading from scoped merging**

In `src/agents.ts`, keep `GENERIC_AGENT` private and add:

```ts
export interface DiscoverScopedAgentsOptions {
  agentScope: AgentScope;
  userAgentsDir: string;
  parentCwd: string;
}

interface DirectoryDiscoveryResult {
  agents: AgentProfile[];
  diagnostics: string[];
}
```

Refactor current file parsing into:

```ts
async function discoverProfileDirectory(
  agentsDir: string,
  source: Exclude<ProfileSource, "builtin">,
): Promise<DirectoryDiscoveryResult>
```

This function must:

1. Return empty arrays on `ENOENT`.
2. Sort Markdown files by filename before reading.
3. Assign `source` from the function argument, never from frontmatter.
4. Keep the first same-source duplicate.
5. Return public-safe diagnostics that identify the source and sanitized profile or filename only; do not include `agentsDir`, full paths, YAML text, prompt text, or raw exception messages.
6. Bound diagnostics to at most 20 finding records and each record to at most 512 UTF-8 bytes, adding one omission record when more findings exist.

Use a local helper so this private loader does not depend on public profile formatting:

```ts
const sanitizeDiagnosticText = (value: string): string =>
  truncateUtf8(
    value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim(),
    512,
  ).text.trim();
```

Store findings through one accumulator that stops retaining findings after 20 and counts the rest. At return time append `Omitted N additional profile diagnostics.` when the omitted count is nonzero.

Preserve the old defense for user files whose frontmatter explicitly says `source: project`: skip them with a bounded diagnostic. Project-directory files may omit `source`; `.pi/agents/` is what makes them project profiles.

- [ ] **Step 4: Implement nearest ancestor lookup**

Add:

```ts
async function findNearestProjectAgentsDir(startCwd: string): Promise<string | undefined>
```

Use `resolve(startCwd)`, `dirname`, and `stat`. At each directory, inspect `<current>/.pi/agents`; return the first entry for which `stat().isDirectory()` is true. Continue upward for `ENOENT` and `ENOTDIR`; stop when `dirname(current) === current`. Throw a generic discovery error for other filesystem failures so the scoped layer can emit a safe diagnostic without exposing a path.

- [ ] **Step 5: Implement merge precedence and compatibility wrapper**

Add:

```ts
export async function discoverScopedAgents(
  options: DiscoverScopedAgentsOptions,
): Promise<DiscoverAgentsResult>
```

Add this helper and use it from both public discovery functions:

```ts
function mergeProfiles(
  user: DirectoryDiscoveryResult | undefined,
  project: DirectoryDiscoveryResult | undefined,
): DiscoverAgentsResult
```

Build an insertion-ordered map starting with `generic`. Load user profiles for `user` or `both`. Load the nearest project profiles for `project` or `both`. During each merge:

- Reject `generic` and emit a bounded reserved-name diagnostic.
- Add user profiles in alphabetical discovery order.
- For project profiles, `Map.set()` replaces a same-named user profile without a diagnostic and preserves its existing list position.
- Append source diagnostics in user-then-project order.

Keep:

```ts
export const discoverAgents = async (agentsDir: string): Promise<DiscoverAgentsResult> =>
  mergeProfiles(await discoverProfileDirectory(agentsDir, "user"), undefined);

export const discoverDefaultAgents = (): Promise<DiscoverAgentsResult> =>
  discoverAgents(join(getAgentDir(), "agents"));
```

The compatibility wrapper remains user-only and built-in-first.

- [ ] **Step 6: Run discovery and integration tests**

Run:

```bash
npx tsx --test --test-name-pattern='agents|scope|nearest|reserved|duplicate|malformed|missing' test/config-agents.test.ts
npx tsx --test test/integration.test.ts
npm run typecheck
```

Expected: selected unit tests pass; real-Pi integration tests remain skipped unless explicitly enabled; type checking passes.

- [ ] **Step 7: Commit scoped discovery**

```bash
git add src/agents.ts test/config-agents.test.ts
git commit -m "feat: discover scoped agent profiles"
```

---

### Task 3: Make public discovery source-aware and scope-aware

**Files:**

- Modify: `src/profile-discovery.ts:1-117`
- Test: `test/profile-discovery.test.ts:1-180`

**Interfaces:**

- Consumes: `AgentScope`, `AgentProfile.source: ProfileSource`, and bounded discovery diagnostics from Task 2.
- Produces: `PublicAgentProfile.source: ProfileSource`, `formatUnknownProfileDiagnostic(name, profiles, scope)`, and `buildPublicAgentDiscovery(profiles, diagnostics)` with one 50 KiB budget.

- [ ] **Step 1: Write failing public-output tests**

Update the existing source type expectations and add:

```ts
test("exposes a project source label without project private data", () => {
  const actual = toPublicAgentProfile({
    name: "project-reviewer",
    description: "Reviews this repository",
    systemPrompt: "SECRET PROJECT PROMPT",
    source: "project",
    filePath: "/workspace/.pi/agents/reviewer.md",
  });

  assert.equal(actual.source, "project");
  assert.doesNotMatch(JSON.stringify(actual), /SECRET PROJECT PROMPT|\/workspace|filePath|systemPrompt/);
});

test("unknown-profile diagnostics identify the searched scope", () => {
  const diagnostic = formatUnknownProfileDiagnostic("missing", [privateProfile], "both");

  assert.match(diagnostic, /^Unknown agent profile in both scope: missing\./);
  assert.doesNotMatch(diagnostic, /SECRET|filePath|\/home\/user/);
});
```

Update every existing call to `formatUnknownProfileDiagnostic` to pass `"user"`. Add a test that passes twenty 512-byte safe diagnostics to `buildPublicAgentDiscovery`, then asserts both rendered content and serialized details remain at or below `PUBLIC_DISCOVERY_MAX_BYTES`, diagnostics are present, and private prompts and paths remain absent. Keep all existing 50 KiB and UTF-8 bounds assertions.

- [ ] **Step 2: Run public discovery tests and confirm they fail**

Run:

```bash
npx tsx --test test/profile-discovery.test.ts
```

Expected: the project source is rejected by the old union or unknown diagnostics omit the scope.

- [ ] **Step 3: Implement source and scope output**

In `src/profile-discovery.ts`:

- Use `ProfileSource` for `PublicAgentProfile.source`.
- Add `scope: AgentScope` to `formatUnknownProfileDiagnostic`.
- Add `diagnostics: string[]` to `PublicAgentDiscovery`.
- Change `buildPublicAgentDiscovery` to accept `diagnostics: readonly string[] = []`.
- Sanitize each diagnostic to 512 UTF-8 bytes, keep at most 20, and render them under `Discovery diagnostics:`.
- Include the same sanitized diagnostics in the serialized details size calculation inside the whole-profile candidate loop. Reduce the included profile prefix as needed so both content and details remain within `PUBLIC_DISCOVERY_MAX_BYTES`; never split a profile record.
- Change its prefix to:

```ts
const prefix = `Unknown agent profile in ${scope} scope: ${unknown}. Available profiles: `;
```

Do not add prompt, path, frontmatter, parent-context, or raw diagnostic fields to `PublicAgentProfile`. `buildPublicAgentDiscovery` returns only its sanitized bounded diagnostic records.

- [ ] **Step 4: Run public discovery tests and type checking**

Run:

```bash
npx tsx --test test/profile-discovery.test.ts
npm run typecheck
```

Expected: all tests and type checks pass.

- [ ] **Step 5: Commit public source labels**

```bash
git add src/profile-discovery.ts test/profile-discovery.test.ts
git commit -m "feat: expose scoped profile sources safely"
```

---

### Task 4: Add tool scope inputs and atomic project confirmation

**Files:**

- Modify: `src/tools.ts:1-142,332-391`
- Test: `test/tools.test.ts:1-260,660-780`

**Interfaces:**

- Consumes: `AGENT_SCOPES`, `AgentScope`, `DiscoverAgentsResult`, and scope-aware unknown diagnostics.
- Changes: `ToolServices.getProfiles()` to `ToolServices.discoverProfiles(scope, parentCwd)`.
- Produces: `ToolServices.confirmProjectAgents(profiles, ctx)` using the existing `WriteConfirmation` result union.
- Changes: `listAgents(input, services, ctx)` and preserves `startJobs(input, services, ctx)`.

- [ ] **Step 1: Write failing schema and default-scope tests**

Update the schema test to require the same optional field on both top-level schemas:

```ts
const startScope = (StartParams as any).properties.agentScope;
const agentsScope = (AgentsParams as any).properties.agentScope;
assert.deepEqual(startScope.enum, ["user", "project", "both"]);
assert.deepEqual(agentsScope.enum, ["user", "project", "both"]);
assert.equal(startScope.default, "user");
assert.equal(agentsScope.default, "user");
assert.equal(Check(StartParams, { tasks: [{ task: "x" }], agentScope: "task" }), false);
```

Change the test adapter helper to record `(scope, parentCwd)` calls. Update every existing direct `listAgents` call to `listAgents({}, services, context)`, and update old unknown-profile expected text to include `user scope`. Add tests proving:

- `listAgents({}...)` and `startJobs({ tasks: [...] }...)` request `user`.
- Explicit `project` and `both` are forwarded.
- A task `cwd: "/task-cwd"` does not affect discovery; `ctx.cwd` is forwarded instead.
- Safe discovery diagnostics appear in model-visible content and `details.diagnostics`; test strings resembling prompts and full paths never appear.

- [ ] **Step 2: Write failing project-confirmation tests**

Add tests with a profile map containing `generic`, one user profile, and two project profiles. Assert:

1. User-only selected profiles never call `confirmProjectAgents`.
2. A mixed batch calls it exactly once with unique selected project profiles after name resolution.
3. Approval enqueues the complete batch.
4. Decline returns `Project agent profiles were declined.` and enqueues nothing.
5. Unavailable or an invalid confirmation result returns `Project agent confirmation requires interactive UI.` and enqueues nothing.
6. In `both`, an overridden profile with final `source: "project"` requires confirmation.
7. Project confirmation and writable confirmation are separate calls; if project confirmation rejects, writable confirmation is not shown.

- [ ] **Step 3: Run tool tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='scope|project agent|registered tools' test/tools.test.ts
```

Expected: schemas lack `agentScope`, the tool adapter uses the old getter, or project confirmation is absent.

- [ ] **Step 4: Add tool schemas and the scoped discovery interface**

In `src/tools.ts`, add:

```ts
const AgentScopeSchema = Type.Optional(StringEnum(AGENT_SCOPES, { default: "user" }));

export const StartParams = Type.Object({
  agentScope: AgentScopeSchema,
  tasks: Type.Array(StartTask, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });

export const AgentsParams = Type.Object({
  agentScope: AgentScopeSchema,
}, { additionalProperties: false });
```

Change `ToolServices` to:

```ts
discoverProfiles(scope: AgentScope, parentCwd: string): Promise<DiscoverAgentsResult>;
confirmProjectAgents(
  profiles: readonly AgentProfile[],
  ctx: ExtensionContext,
): Promise<WriteConfirmation>;
```

Keep `confirmWritable` unchanged.

- [ ] **Step 5: Use one resolution path for listing and launching**

Implement:

```ts
const requestedScope = (scope: AgentScope | undefined): AgentScope => scope ?? "user";
```

`listAgents(input, services, ctx)` must call `services.discoverProfiles(requestedScope(input.agentScope), ctx.cwd)`, pass both discovered profiles and diagnostics to `buildPublicAgentDiscovery`, and return that builder's sanitized bounded diagnostics in `details.diagnostics`. This keeps content plus serialized details within the shared 50 KiB budget.

`startJobs` must:

1. Resolve scope once.
2. Call `discoverProfiles(scope, ctx.cwd)` before validating names.
3. Build the profile map from that result.
4. Include scope in unknown-profile diagnostics.
5. Resolve all requested profiles before confirmation.
6. Deduplicate selected project profiles by name.
7. Confirm project profiles once before writable confirmation.
8. Reject atomically on any non-approved project result.
9. Preserve bounded discovery diagnostics in both model-visible `content` and `details.diagnostics` without exposing paths or prompts. Append them under `Discovery diagnostics:` after the primary start or rejection message. For an unknown profile, keep the scope-aware unknown diagnostic first in `details.diagnostics`, followed by discovery diagnostics.
10. Enqueue only after both required confirmations approve.

Keep the two exact project rejection messages from Step 2.

- [ ] **Step 6: Pass tool input and context through registration**

Change the registered `subagent_agents` execution callback to:

```ts
execute: async (_id, input, _signal, _update, ctx) => listAgents(input, services, ctx),
```

Update its description to mention `user`, `project`, and `both`, with `user` as the default. Update `subagent_start` description only enough to explain that scope applies to the complete batch; do not change background lifecycle guidance.

- [ ] **Step 7: Run the complete tool test file and type checking**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: all tool tests and type checks pass.

- [ ] **Step 8: Commit scoped tool behavior**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: add scoped profile tool inputs"
```

---

### Task 5: Wire runtime discovery and project confirmation

**Files:**

- Modify: `src/index.ts:1-72`
- Test: `test/tools.test.ts:780-980`

**Interfaces:**

- Consumes: `discoverScopedAgents(options)` from Task 2 and scoped `ToolServices` from Task 4.
- Changes: `ExtensionDependencies.discoverProfiles` to accept `DiscoverScopedAgentsOptions`.
- Produces: Runtime adapters for `discoverProfiles`, `confirmProjectAgents`, and the unchanged writable/default interfaces.

- [ ] **Step 1: Write failing runtime tests**

Update runtime dependency stubs to accept discovery options and config objects to include `confirmProjectAgents`. Add tests asserting:

```ts
assert.deepEqual(discoveryCalls, [
  {
    agentScope: "both",
    userAgentsDir: "/pi-agent/agents",
    parentCwd: "/workspace",
  },
]);
```

Add runtime tests for:

- Project confirmation enabled + approval starts the batch and records one confirmation.
- Project confirmation enabled + `hasUI: false` rejects the batch.
- Project confirmation enabled + user-only profile starts without confirmation.
- `confirmProjectAgents: false` starts a project profile without UI for trusted automation.
- A mixed writable/project batch records two separate confirmations after approval.
- Project discovery diagnostics are returned by the tool call and are not sent as startup notifications.

- [ ] **Step 2: Run runtime tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='runtime.*(project|scope|config|profiles)' test/tools.test.ts
```

Expected: runtime still loads one static session profile map and has no project confirmation adapter.

- [ ] **Step 3: Replace session profile caching with the shared resolver**

In `src/index.ts`:

- Import `discoverScopedAgents` and `DiscoverScopedAgentsOptions`.
- Change `ExtensionDependencies.discoverProfiles` to `(options: DiscoverScopedAgentsOptions) => Promise<DiscoverAgentsResult>`.
- Default to `discoverScopedAgents`.
- Remove the mutable session-wide `profiles` map.
- Initialize config as:

```ts
let config: SimpleSubagentsConfig = {
  confirmWrites: false,
  confirmProjectAgents: true,
};
```

Provide this adapter:

```ts
discoverProfiles: (agentScope, parentCwd) => discoverProfiles({
  agentScope,
  userAgentsDir: join(resolveAgentDir(), "agents"),
  parentCwd,
}),
```

During `session_start`, load only `simple-subagents.json`. Profile discovery occurs in `subagent_agents` or `subagent_start`, so each call uses its scope and current parent cwd. Do not notify private discovery diagnostics at session start.

- [ ] **Step 4: Implement runtime project confirmation**

Add:

```ts
confirmProjectAgents: async (profiles, ctx) => {
  if (!config.confirmProjectAgents || profiles.length === 0) return "approved";
  if (!ctx.hasUI) return "unavailable";
  return (await ctx.ui.confirm(
    "Allow project subagent profiles?",
    `Allow this batch to use ${profiles.length} repository-controlled project profile${profiles.length === 1 ? "" : "s"}?`,
  )) ? "approved" : "declined";
},
```

The count is unique selected profile names, not job count. Do not display prompts, file paths, or raw frontmatter in the confirmation.

- [ ] **Step 5: Run runtime, tool, and type checks**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: all runtime/tool tests and type checks pass.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "feat: confirm project agent profiles"
```

---

### Task 6: Document project profile use and security

**Files:**

- Modify: `README.md:44-105`
- Test: `test/package.test.ts:1-45`

**Interfaces:**

- Consumes: Final schemas, defaults, precedence, and confirmation text from Tasks 1-5.
- Produces: User-facing documentation for all new behavior.

- [ ] **Step 1: Add a failing README contract test**

In `test/package.test.ts`, add:

```ts
test("README documents project agent scope and confirmation", async () => {
  const readme = await readFile("README.md", "utf8");

  assert.match(readme, /agentScope/);
  assert.match(readme, /user.*project.*both/s);
  assert.match(readme, /\.pi\/agents/);
  assert.match(readme, /nearest/i);
  assert.match(readme, /project.*override.*user/is);
  assert.match(readme, /generic.*cannot.*override/is);
  assert.match(readme, /confirmProjectAgents/);
  assert.match(readme, /repository-controlled/i);
  assert.match(readme, /bundled subagent example/i);
  assert.match(readme, /not an official Pi standard/i);
});
```

- [ ] **Step 2: Run the README test and confirm it fails**

Run:

```bash
npx tsx --test --test-name-pattern='README documents project agent scope' test/package.test.ts
```

Expected: failure because README currently says project profiles are intentionally ignored.

- [ ] **Step 3: Rewrite the Agents and access scope documentation**

In `README.md`, replace “project-scoped profiles are intentionally ignored” with clear sections that include:

```json
{ "agentScope": "both" }
```

for `subagent_agents`, and:

```json
{
  "agentScope": "project",
  "tasks": [{ "task": "Review this repository", "agent": "reviewer" }]
}
```

for `subagent_start`.

State explicitly:

- Omitted `agentScope` means `user`.
- `user` reads `~/.pi/agent/agents/*.md`.
- `project` walks upward from the parent session cwd to the nearest `.pi/agents/*.md`.
- `both` merges sources and project overrides a same-named user profile.
- `generic` remains built-in, first, and cannot be overridden.
- A task's `cwd` does not affect profile discovery.
- Discovery labels profiles `builtin`, `user`, or `project` without exposing private prompts or paths.
- The unchanged Markdown format aligns with Pi's bundled subagent example; it is not an official Pi standard.

- [ ] **Step 4: Document project confirmation configuration**

Replace the one-property configuration example with:

```json
{
  "confirmWrites": false,
  "confirmProjectAgents": true
}
```

Explain that project profiles are repository-controlled prompts, confirmation defaults on, one confirmation covers all selected project profiles in a batch, decline or unavailable UI rejects the complete batch, and only the user config may set `confirmProjectAgents: false` for trusted automation. Keep writable confirmation described as separate.

- [ ] **Step 5: Run README and package tests**

Run:

```bash
npx tsx --test test/package.test.ts
```

Expected: all package and README contract tests pass.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md test/package.test.ts
git commit -m "docs: explain project agent scopes"
```

---

### Task 7: Final regression and security verification

**Files:**

- Verify: `src/**/*.ts`
- Verify: `test/**/*.test.ts`
- Verify: `README.md`

**Interfaces:**

- Consumes: All prior task outputs.
- Produces: A verified implementation ready for review.

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: all unit tests pass, two opt-in real-Pi tests may remain skipped, and TypeScript reports no errors.

- [ ] **Step 2: Run focused security assertions**

Run:

```bash
npx tsx --test --test-name-pattern='private|SECRET|scope|project agent|reserved|unknown-profile|malformed' test/*.test.ts
```

Expected: all selected tests pass; outputs contain no prompt or path leaks.

- [ ] **Step 3: Check repository and diagnostics**

Run:

```bash
git diff --check
git status --short
git log --oneline -7
```

Then run `lens_diagnostics` with `mode: "all"` for all edited files.

Expected: no whitespace errors, no uncommitted implementation files, one focused commit per task, and no blocking diagnostics.

- [ ] **Step 4: Request code review**

Use the `superpowers:requesting-code-review` skill. Review against `docs/superpowers/specs/2026-08-02-project-agent-scope-design.md`, with special attention to atomic confirmation, directory-origin trust, `generic` reservation, path/prompt privacy, and 50 KiB public output bounds.
