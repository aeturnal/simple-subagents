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

In `test/tools.test.ts`, add `confirmProjectAgents: true` to every typed `loadConfig` fixture. This is a compile-only fixture update; project-confirmation behavior remains for Tasks 6-7.

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

### Task 2: Deepen single-directory profile loading

**Files:**

- Modify: `src/agents.ts:1-136`
- Test: `test/config-agents.test.ts:64-150`
- Verify: `test/integration.test.ts`

**Interfaces:**

- Consumes: `ProfileSource` from Task 1.
- Keeps internal: `discoverProfileDirectory(agentsDir, source)` and bounded diagnostic helpers.
- Preserves: `discoverAgents(agentsDir)` as the user-only, built-in-first compatibility interface used by integration tests.

- [ ] **Step 1: Write failing loader and diagnostic tests**

Keep the existing user-profile tests and add focused tests asserting:

- A user profile named `generic` cannot replace the built-in and emits a reserved-name diagnostic.
- Duplicate user files keep alphabetically first content and emit one duplicate diagnostic.
- Malformed files do not stop valid later files.
- Missing directories return only `generic` with no diagnostics.
- More than 20 malformed or duplicate files produce at most 20 finding records plus one omission record, with every record at most 512 UTF-8 bytes.
- Diagnostics do not contain the temporary root path, profile prompt, YAML text, or raw parser error.
- A user-directory file whose frontmatter explicitly says `source: project` remains excluded.

Use the public `discoverAgents(agentsDir)` interface for these tests; do not export the private loader just for testing.

- [ ] **Step 2: Run loader tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='agents|reserved|duplicate|malformed|missing|diagnostic' test/config-agents.test.ts
```

Expected: reserved `generic` handling or bounded path-safe diagnostics fail under the current implementation.

- [ ] **Step 3: Extract the private directory loader**

In `src/agents.ts`, keep `GENERIC_AGENT` private and add:

```ts
interface DirectoryDiscoveryResult {
  agents: AgentProfile[];
  diagnostics: string[];
}

async function discoverProfileDirectory(
  agentsDir: string,
  source: Exclude<ProfileSource, "builtin">,
): Promise<DirectoryDiscoveryResult>
```

The loader must return empty arrays on `ENOENT`, sort Markdown files by filename, assign trusted `source` from its argument, keep the first same-source duplicate, and never add `generic` itself. Preserve the defense that skips `source: project` frontmatter only when loading the user directory.

- [ ] **Step 4: Bound and sanitize loader diagnostics**

Use this local helper so the private loader does not depend on public profile formatting:

```ts
const sanitizeDiagnosticText = (value: string): string =>
  truncateUtf8(
    value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim(),
    512,
  ).text.trim();
```

Store diagnostics through one accumulator that retains at most 20 findings and counts the rest. Append `Omitted N additional profile diagnostics.` when needed. Diagnostic records may identify the trusted source and sanitized filename or profile name, but must not include `agentsDir`, full paths, prompts, frontmatter text, parser internals, or raw exception messages.

- [ ] **Step 5: Preserve the compatibility interface and reserve generic**

Implement a private merge helper for reuse by Task 3:

```ts
function mergeProfiles(
  user: DirectoryDiscoveryResult | undefined,
  project: DirectoryDiscoveryResult | undefined,
): DiscoverAgentsResult
```

It starts an insertion-ordered map with `GENERIC_AGENT`, rejects any loaded profile named `generic` with a bounded reserved-name diagnostic, then adds user profiles. Keep:

```ts
export const discoverAgents = async (agentsDir: string): Promise<DiscoverAgentsResult> =>
  mergeProfiles(await discoverProfileDirectory(agentsDir, "user"), undefined);

export const discoverDefaultAgents = (): Promise<DiscoverAgentsResult> =>
  discoverAgents(join(getAgentDir(), "agents"));
```

- [ ] **Step 6: Run loader, integration, and type checks**

Run:

```bash
npx tsx --test --test-name-pattern='agents|reserved|duplicate|malformed|missing|diagnostic' test/config-agents.test.ts
npx tsx --test test/integration.test.ts
npm run typecheck
```

Expected: selected unit tests pass; real-Pi integration tests remain skipped unless explicitly enabled; type checking passes.

- [ ] **Step 7: Commit the directory loader**

```bash
git add src/agents.ts test/config-agents.test.ts
git commit -m "refactor: deepen agent directory loading"
```

---

### Task 3: Add nearest-project discovery and scoped merging

**Files:**

- Modify: `src/agents.ts`
- Test: `test/config-agents.test.ts:150-240`

**Interfaces:**

- Consumes: the private loader and merge helper from Task 2 plus `AgentScope` from Task 1.
- Produces: the small external discovery seam `DiscoverScopedAgentsOptions` and `discoverScopedAgents(options)`.
- Keeps internal: `findNearestProjectAgentsDir(startCwd)`; nearest-walk behavior is tested through `discoverScopedAgents`.

- [ ] **Step 1: Write failing scoped-discovery tests**

Create this test tree:

```text
<root>/user-agents/a-user.md                       name: reviewer, description: User reviewer
<root>/user-agents/b-user-helper.md                name: user-helper
<root>/.pi/agents/root.md                          name: root-agent
<root>/packages/app/.pi/agents/a-project.md        name: reviewer, description: Project reviewer
<root>/packages/app/.pi/agents/b-project-helper.md name: project-helper
<root>/packages/app/src/                           parent cwd
```

Add separate `user`, `project`, and `both` tests. Assert that `generic` is first; each single-source scope excludes the other source; nearest project lookup selects `packages/app/.pi/agents/` rather than the root project directory; and `both` includes both unique profiles while selecting the project `reviewer` without a duplicate warning:

```ts
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

Also test missing project directories, a reserved project `generic`, malformed project files, and `source: "project"` on returned project profiles. The real project `filePath` may exist only in the private `AgentProfile`.

- [ ] **Step 2: Run scoped tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='scope|nearest|project|both' test/config-agents.test.ts
```

Expected: `discoverScopedAgents` is missing or project profiles are not discovered.

- [ ] **Step 3: Implement private nearest-ancestor lookup**

Add:

```ts
async function findNearestProjectAgentsDir(startCwd: string): Promise<string | undefined>
```

Use `resolve(startCwd)`, `dirname`, and `stat`. At each directory inspect `<current>/.pi/agents`; return the first entry for which `stat().isDirectory()` is true. Continue upward for `ENOENT` and `ENOTDIR`; stop when `dirname(current) === current`. Throw a generic discovery error for other filesystem failures so the scoped interface can emit a safe diagnostic without a path.

- [ ] **Step 4: Implement scoped loading and precedence**

Add:

```ts
export interface DiscoverScopedAgentsOptions {
  agentScope: AgentScope;
  userAgentsDir: string;
  parentCwd: string;
}

export async function discoverScopedAgents(
  options: DiscoverScopedAgentsOptions,
): Promise<DiscoverAgentsResult>
```

Load user profiles for `user` or `both`, and only the nearest project directory for `project` or `both`. Extend Task 2's `mergeProfiles` so project profiles replace same-named user profiles through `Map.set()` without a duplicate diagnostic, while unique project profiles append in alphabetical order. Keep `generic` reserved for both sources and append diagnostics in user-then-project order.

- [ ] **Step 5: Run scoped discovery and type checks**

Run:

```bash
npx tsx --test test/config-agents.test.ts
npm run typecheck
```

Expected: all configuration and discovery tests pass; TypeScript reports no errors.

- [ ] **Step 6: Commit scoped merging**

```bash
git add src/agents.ts test/config-agents.test.ts
git commit -m "feat: discover scoped agent profiles"
```

---

### Task 4: Make public discovery source-aware and scope-aware

**Files:**

- Modify: `src/profile-discovery.ts:1-117`
- Test: `test/profile-discovery.test.ts:1-180`

**Interfaces:**

- Consumes: `AgentScope`, `AgentProfile.source: ProfileSource`, and bounded discovery diagnostics from Tasks 2-3.
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
- Add `scope: AgentScope = "user"` to `formatUnknownProfileDiagnostic` so existing user-only callers remain valid until Task 5 passes scope explicitly.
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

### Task 5: Add scoped profile listing and shared tool discovery

**Files:**

- Modify: `src/tools.ts:1-142,332-391`
- Modify: `src/index.ts:1-72`
- Test: `test/tools.test.ts:1-140,660-880`

**Interfaces:**

- Consumes: `AGENT_SCOPES`, `AgentScope`, `DiscoverAgentsResult`, and bounded public discovery from Tasks 3-4.
- Changes: `ToolServices.getProfiles()` to `ToolServices.discoverProfiles(scope, parentCwd)`.
- Changes: `ExtensionDependencies.discoverProfiles` to accept `DiscoverScopedAgentsOptions` and default to `discoverScopedAgents`.
- Changes: `listAgents(input, services, ctx)`; `startJobs` uses the same discovery interface with fixed `user` scope until Task 6 safely adds start scope.

- [ ] **Step 1: Write failing listing-scope tests**

Update the agents schema test:

```ts
const agentsScope = (AgentsParams as any).properties.agentScope;
assert.deepEqual(agentsScope.enum, ["user", "project", "both"]);
assert.equal(agentsScope.default, "user");
assert.equal(Check(AgentsParams, { agentScope: "task" }), false);
```

Change the test adapter helper to record `(scope, parentCwd)` calls. Update every existing direct `listAgents` call to `listAgents({}, services, context)`, and update existing unknown-profile expectations to include `user scope`. Add tests proving:

- `listAgents({}...)` requests `user`.
- Explicit `project` and `both` are forwarded.
- `startJobs({ tasks: [...] }...)` still requests `user` from the same discovery interface.
- A task `cwd: "/task-cwd"` does not affect discovery; `ctx.cwd` is forwarded instead.
- Safe discovery diagnostics appear in model-visible content and `details.diagnostics`; prompt-like strings and full paths never appear.
- A registered `subagent_agents({ agentScope: "both" })` call forwards `{ agentScope: "both", userAgentsDir: "/pi-agent/agents", parentCwd: "/workspace" }` to the injected runtime discovery adapter.
- Existing runtime tests no longer expect profile discovery during `session_start`; a safe profile diagnostic is returned by the later tool call instead of sent as a startup notification.

- [ ] **Step 2: Run listing tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='listAgents|agents schema|default.*scope|discovery diagnostic' test/tools.test.ts
```

Expected: `AgentsParams` lacks `agentScope` or the tool adapter still exposes a static profile map.

- [ ] **Step 3: Add the agents scope schema and shared discovery interface**

In `src/tools.ts`, add:

```ts
const AgentScopeSchema = Type.Optional(StringEnum(AGENT_SCOPES, { default: "user" }));

export const AgentsParams = Type.Object({
  agentScope: AgentScopeSchema,
}, { additionalProperties: false });
```

Change `ToolServices` from `getProfiles()` to:

```ts
discoverProfiles(scope: AgentScope, parentCwd: string): Promise<DiscoverAgentsResult>;
```

Change `ExtensionDependencies.discoverProfiles` to `(options: DiscoverScopedAgentsOptions) => Promise<DiscoverAgentsResult>` and default it to `discoverScopedAgents`. Keep `StartParams` user-only in this task. Change `startJobs` to call `discoverProfiles("user", ctx.cwd)`, preserving current launch behavior while moving both tools onto one discovery seam.

- [ ] **Step 4: Implement scoped public listing and runtime discovery**

Add:

```ts
const requestedScope = (scope: AgentScope | undefined): AgentScope => scope ?? "user";
```

`listAgents(input, services, ctx)` calls `discoverProfiles(requestedScope(input.agentScope), ctx.cwd)`, passes both profiles and diagnostics to `buildPublicAgentDiscovery`, and returns the builder's sanitized bounded diagnostics in `details.diagnostics`. Keep content plus serialized details within the shared 50 KiB budget.

In `src/index.ts`, remove the session-wide profile map and provide:

```ts
discoverProfiles: (agentScope, parentCwd) => discoverProfiles({
  agentScope,
  userAgentsDir: join(resolveAgentDir(), "agents"),
  parentCwd,
}),
```

During `session_start`, load only `simple-subagents.json`. Discovery diagnostics now belong to the requesting tool call, not startup notifications.

- [ ] **Step 5: Pass listing input and context through registration**

Change the registered callback to:

```ts
execute: async (_id, input, _signal, _update, ctx) => listAgents(input, services, ctx),
```

Update the `subagent_agents` description to mention `user`, `project`, and `both`, with `user` as the default.

- [ ] **Step 6: Run tool tests and type checking**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: all tool tests pass, starts remain user-only, and type checking passes.

- [ ] **Step 7: Commit scoped listing**

```bash
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "feat: list scoped agent profiles"
```

---

### Task 6: Add start scope and atomic project confirmation

**Files:**

- Modify: `src/tools.ts:20-142,332-360`
- Modify: `src/index.ts:20-50`
- Test: `test/tools.test.ts:100-280,700-790`

**Interfaces:**

- Consumes: `AgentScopeSchema`, `requestedScope`, and `ToolServices.discoverProfiles` from Task 5.
- Produces: `ToolServices.confirmProjectAgents(profiles, ctx)` using the existing `WriteConfirmation` result union.
- Changes: `StartParams` and `startJobs` to support one scope for the complete batch.

- [ ] **Step 1: Write failing start-scope and confirmation tests**

Require the start schema to expose the same scope values:

```ts
const startScope = (StartParams as any).properties.agentScope;
assert.deepEqual(startScope.enum, ["user", "project", "both"]);
assert.equal(startScope.default, "user");
assert.equal(Check(StartParams, { tasks: [{ task: "x" }], agentScope: "task" }), false);
```

Add `confirmProjectAgents: async () => "approved"` to the default test adapter so existing user-only tests still satisfy `ToolServices`. Add tests with `generic`, one user profile, and two project profiles. Assert:

1. Omitted scope requests `user`; explicit `project` and `both` are forwarded with `ctx.cwd`.
2. User-only selected profiles never call `confirmProjectAgents`.
3. A mixed batch calls it exactly once with unique selected project profiles after resolution.
4. Approval enqueues the complete batch.
5. Decline returns `Project agent profiles were declined.` and enqueues nothing.
6. Unavailable or invalid confirmation returns `Project agent confirmation requires interactive UI.` and enqueues nothing.
7. An overridden `both` profile whose final source is `project` requires confirmation.
8. Project and writable confirmation are separate; project rejection prevents writable confirmation.
9. Scope-aware unknown diagnostics name the searched scope and remain first in `details.diagnostics`.

- [ ] **Step 2: Run start tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='start.*scope|project agent|unknown profile|registered tools' test/tools.test.ts
```

Expected: `StartParams` lacks `agentScope` or project confirmation is absent.

- [ ] **Step 3: Add start scope and confirmation interface**

Change `StartParams` to:

```ts
export const StartParams = Type.Object({
  agentScope: AgentScopeSchema,
  tasks: Type.Array(StartTask, { minItems: 1, maxItems: 8 }),
}, { additionalProperties: false });
```

Add to `ToolServices`:

```ts
confirmProjectAgents(
  profiles: readonly AgentProfile[],
  ctx: ExtensionContext,
): Promise<WriteConfirmation>;
```

Keep `confirmWritable` unchanged. Add a temporary fail-closed runtime adapter in `src/index.ts`:

```ts
confirmProjectAgents: async () => "unavailable",
```

Task 7 replaces this safe default with user configuration and interactive confirmation. Until then, runtime project launches are rejected rather than launched without trust approval.

- [ ] **Step 4: Resolve and confirm the complete batch atomically**

`startJobs` must:

1. Resolve scope once with `requestedScope`.
2. Call `discoverProfiles(scope, ctx.cwd)` before validating names.
3. Build the profile map and include scope in unknown-profile diagnostics.
4. Resolve every requested profile before confirmation.
5. Deduplicate selected project profiles by name.
6. Confirm project profiles once before writable confirmation.
7. Reject the complete batch on any non-approved project result.
8. Enqueue only after both required confirmations approve.

Preserve bounded discovery diagnostics in model-visible `content` and `details.diagnostics`. Append them under `Discovery diagnostics:` after the primary message. For an unknown profile, keep the scope-aware unknown diagnostic first, followed by discovery diagnostics. Keep the exact rejection messages from Step 1.

- [ ] **Step 5: Update registered start guidance**

Update the `subagent_start` description to say scope applies to the complete batch. Do not change background lifecycle guidance.

- [ ] **Step 6: Run tool tests and type checking**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: all tool tests and type checks pass.

- [ ] **Step 7: Commit safe scoped launching**

```bash
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "feat: confirm scoped project launches"
```

---

### Task 7: Enable configured runtime project confirmation

**Files:**

- Modify: `src/index.ts:20-55`
- Test: `test/tools.test.ts:800-1000`

**Interfaces:**

- Consumes: `SimpleSubagentsConfig.confirmProjectAgents` from Task 1 and the fail-closed confirmation adapter from Task 6.
- Produces: The runtime UI/config adapter for `ToolServices.confirmProjectAgents`.

- [ ] **Step 1: Write failing runtime confirmation tests**

Add runtime tests for:

- Enabled confirmation + approval starts a project batch and records one confirmation.
- Enabled confirmation + rejection starts no jobs.
- Enabled confirmation + `hasUI: false` rejects the complete batch.
- A user-only profile starts without project confirmation.
- `confirmProjectAgents: false` starts a project profile without UI for trusted automation.
- A mixed writable/project batch records two separate confirmations after approval.
- Confirmation text reports the number of unique project profiles without exposing prompts or paths.

- [ ] **Step 2: Run runtime tests and confirm they fail**

Run:

```bash
npx tsx --test --test-name-pattern='runtime.*project|trusted automation|separate confirmations' test/tools.test.ts
```

Expected: the Task 6 fail-closed adapter rejects project launches even when UI approval or the trusted-automation setting should permit them.

- [ ] **Step 3: Replace the fail-closed adapter with configured UI confirmation**

Initialize runtime config as:

```ts
let config: SimpleSubagentsConfig = {
  confirmWrites: false,
  confirmProjectAgents: true,
};
```

Replace Task 6's temporary adapter with:

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

The count is unique selected profile names, not job count. Do not display prompts, paths, raw frontmatter, or task text.

- [ ] **Step 4: Run runtime, tool, and type checks**

Run:

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: all runtime/tool tests and type checks pass.

- [ ] **Step 5: Commit runtime confirmation**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "feat: confirm project agent profiles"
```

---

### Task 8: Document project profile use and security

**Files:**

- Modify: `README.md:44-105`
- Test: `test/package.test.ts:1-45`

**Interfaces:**

- Consumes: Final schemas, defaults, precedence, and confirmation text from Tasks 1-7.
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

### Task 9: Final regression and security verification

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
