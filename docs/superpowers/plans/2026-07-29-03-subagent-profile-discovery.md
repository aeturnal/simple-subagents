# Subagent Profile Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded, read-only `subagent_agents` tool that safely exposes selectable profile names and launch capabilities while keeping private profile data hidden.

**Architecture:** Keep private discovery in `agents.ts`, add one pure module that owns launch-allowlist calculation and one pure module that maps private profiles into sanitized public DTOs and bounded discovery output. Both `process-runner.ts` and public discovery consume the same allowlist helper; `tools.ts` only registers, executes, and renders the new tool and improves unknown-profile diagnostics.

**Tech Stack:** TypeScript 5.9, Node.js 22.19 built-ins, Pi extension/TUI APIs 0.82.x, TypeBox, Node's test runner through `tsx`.

## Global Constraints

- Start from the released Plans 01–02 state; preserve stale-safe notifications and `subagent_wait` unchanged.
- The tool is read-only and takes an empty object.
- Discovery order is built-in `generic` first, then accepted user profiles in existing deterministic order.
- Generic read-only launch tools are exactly `read`, `grep`, `find`, `ls`.
- Generic writable launch tools are exactly `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`.
- `supportsWrite` is true only when the writable launch allowlist contains `bash`, `edit`, or `write`.
- Sanitize names to 128 UTF-8 bytes, descriptions to 512 UTF-8 bytes, models to 512 UTF-8 bytes, and tool names to 128 UTF-8 bytes.
- Cap both model-visible content and public details at `50 * 1024` UTF-8 bytes; omit whole records only and report the omitted count.
- Never expose `systemPrompt`, `filePath`, raw frontmatter, profile-discovery diagnostics, credentials, parent prompts, or session context.
- Keep existing profile discovery, first-valid-wins duplicates, invalid-profile skipping, trust, write confirmation, and job authorization unchanged.
- Launch allowlists describe requested child Pi arguments, not guaranteed runtime tools or an OS-level sandbox.
- Add no configuration, persistence, runtime dependency, fuzzy matching, or project-scoped profile support.

---

## File Structure

- `src/profile-capabilities.ts` — fixed access-mode tool order and the shared pure launch-allowlist calculation.
- `src/profile-discovery.ts` — public DTO, sanitization, privacy boundary, model-visible formatting, omission accounting, and byte bounds.
- `src/process-runner.ts` — consume the shared launch-allowlist helper when constructing Pi arguments.
- `src/tools.ts` — expose `subagent_agents`, render compact/expanded results, and improve unknown-profile diagnostics.
- `test/profile-capabilities.test.ts` — pure capability and ordering tests.
- `test/profile-discovery.test.ts` — public mapping, sanitization, secrecy, deterministic order, and byte-limit tests.
- `test/process-runner.test.ts` — prove child `--tools` arguments use the same shared result advertised by discovery.
- `test/tools.test.ts` — tool schema, execution, diagnostics, registration, and TUI rendering tests.
- `README.md` — document discovery, capability versus authorization, and private fields.

---

### Task 1: Define the shared launch-allowlist calculation

**Files:**
- Create: `src/profile-capabilities.ts`
- Create: `test/profile-capabilities.test.ts`

**Interfaces:**
- Consumes: `AgentProfile` and `AccessMode` from `src/types.ts`.
- Produces: `getLaunchToolAllowlist(profile: AgentProfile, accessMode: AccessMode): string[]`.
- The returned array is a new mutable array in fixed access-mode order; callers may join it without mutating shared constants.

- [ ] **Step 1: Write failing pure-helper tests**

Create `test/profile-capabilities.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getLaunchToolAllowlist } from "../src/profile-capabilities.ts";
import type { AgentProfile } from "../src/types.ts";

const profile = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  name: "reviewer",
  description: "Reviews code",
  systemPrompt: "Review carefully.",
  source: "user",
  ...overrides,
});

test("generic exposes fixed read-only and writable launch allowlists", () => {
  const generic = profile({ name: "generic", source: "builtin", tools: ["unknown"] });

  assert.deepEqual(getLaunchToolAllowlist(generic, "read-only"), ["read", "grep", "find", "ls"]);
  assert.deepEqual(getLaunchToolAllowlist(generic, "write"), ["read", "grep", "find", "ls", "bash", "edit", "write"]);
});

test("named profiles intersect, deduplicate, and emit in fixed allowlist order", () => {
  const named = profile({ tools: ["write", "read", "bash", "read", "unknown", "edit"] });

  assert.deepEqual(getLaunchToolAllowlist(named, "read-only"), ["read"]);
  assert.deepEqual(getLaunchToolAllowlist(named, "write"), ["read", "bash", "edit", "write"]);
});

test("named profiles without requested tools expose empty launch allowlists", () => {
  assert.deepEqual(getLaunchToolAllowlist(profile({ tools: undefined }), "read-only"), []);
  assert.deepEqual(getLaunchToolAllowlist(profile({ tools: undefined }), "write"), []);
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npx tsx --test test/profile-capabilities.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/profile-capabilities.ts`.

- [ ] **Step 3: Implement the minimal pure helper**

Create `src/profile-capabilities.ts`:

```ts
import type { AccessMode, AgentProfile } from "./types.js";

const READ_ONLY_TOOL_ORDER = ["read", "grep", "find", "ls"] as const;
const WRITABLE_TOOL_ORDER = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

export function getLaunchToolAllowlist(profile: AgentProfile, accessMode: AccessMode): string[] {
  const permitted = accessMode === "write" ? WRITABLE_TOOL_ORDER : READ_ONLY_TOOL_ORDER;
  if (profile.name === "generic") return [...permitted];

  const requested = new Set(profile.tools ?? []);
  return permitted.filter((tool) => requested.has(tool));
}
```

- [ ] **Step 4: Run the focused test and typecheck**

Run:

```bash
npx tsx --test test/profile-capabilities.test.ts
npm run typecheck
```

Expected: PASS; named tools are deduplicated and normalized to fixed launch order.

- [ ] **Step 5: Commit the shared calculation**

```bash
git add src/profile-capabilities.ts test/profile-capabilities.test.ts
git commit -m "feat: share subagent launch capabilities"
```

---

### Task 2: Make process launch consume the shared allowlist

**Files:**
- Modify: `src/process-runner.ts:10-11,105-109,152-154`
- Modify: `test/process-runner.test.ts:165-220`

**Interfaces:**
- Consumes: `getLaunchToolAllowlist(profile, accessMode)` from Task 1.
- Produces: unchanged `PiProcessRunner.run(options: ProcessRunOptions): RunningProcess` behavior, with `--tools` ordered exactly like public discovery.
- Named profiles whose shared allowlist is empty still receive `--no-tools`; generic always receives `--tools`.

- [ ] **Step 1: Tighten runner tests around the shared result**

Import the helper in `test/process-runner.test.ts`:

```ts
import { getLaunchToolAllowlist } from "../src/profile-capabilities.ts";
```

Replace the named writable profile assertion with a deliberately scrambled and duplicated request:

```ts
const selected = profile({ tools: ["write", "bash", "read", "edit", "read", "unknown"] });
const running = runner.run({
  cwd: "/workspace",
  request: request(true),
  profile: selected,
  onProgress() {},
});

assert.equal(
  argumentValue(invocation().args, "--tools"),
  getLaunchToolAllowlist(selected, "write").join(","),
);
assert.equal(argumentValue(invocation().args, "--tools"), "read,bash,edit,write");
```

Keep the existing generic, no-tools, and read-only tests unchanged.

- [ ] **Step 2: Run the runner tests to verify RED**

Run:

```bash
npx tsx --test test/process-runner.test.ts
```

Expected: FAIL because the current local `getTools()` preserves requested order and returns `write,bash,read,edit,read`.

- [ ] **Step 3: Replace local permission sets with the shared helper**

In `src/process-runner.ts`, add:

```ts
import { getLaunchToolAllowlist } from "./profile-capabilities.js";
```

Delete `READ_ONLY_TOOLS`, `WRITE_TOOLS`, and the local `getTools()` function. Replace the launch calculation with:

```ts
const accessMode = options.request.writeAccess ? "write" : "read-only";
const tools = getLaunchToolAllowlist(options.profile, accessMode);
if (tools.length > 0) args.push("--tools", tools.join(","));
else if (options.profile.name !== "generic") args.push("--no-tools");
```

- [ ] **Step 4: Run focused and regression tests**

Run:

```bash
npx tsx --test test/profile-capabilities.test.ts test/process-runner.test.ts
npm run typecheck
```

Expected: PASS; the helper result and child Pi `--tools` argument are equal.

- [ ] **Step 5: Commit runner adoption**

```bash
git add src/process-runner.ts test/process-runner.test.ts
git commit -m "refactor: use shared subagent launch allowlist"
```

---

### Task 3: Map private profiles to sanitized public DTOs

**Files:**
- Create: `src/profile-discovery.ts`
- Create: `test/profile-discovery.test.ts`

**Interfaces:**
- Consumes: private `AgentProfile` records and `getLaunchToolAllowlist()` from Task 1.
- Produces: `PublicAgentProfile`, `sanitizePublicText(value, maxBytes)`, and `toPublicAgentProfile(profile)`.
- `toPublicAgentProfile()` constructs an explicit object; it never spreads an `AgentProfile`.

- [ ] **Step 1: Write failing DTO, capability, sanitization, and secrecy tests**

Create `test/profile-discovery.test.ts` with these fixtures and assertions:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublicText, toPublicAgentProfile } from "../src/profile-discovery.ts";
import type { AgentProfile } from "../src/types.ts";

const privateProfile: AgentProfile = {
  name: " reviewer\n\u0000name ",
  description: ` Review\r\n${"😀".repeat(200)} `,
  systemPrompt: "SECRET SYSTEM PROMPT",
  source: "user",
  model: ` provider/model\u0007${"界".repeat(200)} `,
  tools: ["write", "grep", "grep", "read", "unknown\nsecret"],
  filePath: "/home/user/.pi/agent/agents/reviewer.md",
};

test("maps only bounded public fields and derives launch capabilities", () => {
  const actual = toPublicAgentProfile(privateProfile);

  assert.equal(actual.name, "reviewer name");
  assert.ok(Buffer.byteLength(actual.name, "utf8") <= 128);
  assert.ok(Buffer.byteLength(actual.description, "utf8") <= 512);
  assert.ok(Buffer.byteLength(actual.model ?? "", "utf8") <= 512);
  assert.equal(actual.source, "user");
  assert.equal(actual.inheritsParentModel, false);
  assert.deepEqual(actual.readOnlyToolAllowlist, ["read", "grep"]);
  assert.deepEqual(actual.writableToolAllowlist, ["read", "grep", "write"]);
  assert.equal(actual.supportsWrite, true);

  const serialized = JSON.stringify(actual);
  assert.doesNotMatch(serialized, /SECRET SYSTEM PROMPT|filePath|systemPrompt|\/home\/user/);
  assert.doesNotMatch(serialized, /[\u0000-\u001f\u007f]/);
});

test("represents parent-model inheritance and profiles without tools", () => {
  const actual = toPublicAgentProfile({
    name: "reader",
    description: "Reads only",
    systemPrompt: "private",
    source: "user",
  });

  assert.equal(actual.model, null);
  assert.equal(actual.inheritsParentModel, true);
  assert.deepEqual(actual.readOnlyToolAllowlist, []);
  assert.deepEqual(actual.writableToolAllowlist, []);
  assert.equal(actual.supportsWrite, false);
});

test("sanitization collapses whitespace and truncates without broken UTF-8", () => {
  const actual = sanitizePublicText(`  alpha\n\u0000\t${"😀".repeat(100)}  `, 128);

  assert.ok(Buffer.byteLength(actual, "utf8") <= 128);
  assert.doesNotMatch(actual, /[\u0000-\u001f\u007f]|\s{2,}|�/);
  assert.equal(Buffer.from(actual, "utf8").toString("utf8"), actual);
});
```

Also add a generic assertion:

```ts
const generic = toPublicAgentProfile({
  name: "generic",
  description: "Generic coding agent",
  systemPrompt: "private",
  source: "builtin",
});
assert.deepEqual(generic.readOnlyToolAllowlist, ["read", "grep", "find", "ls"]);
assert.deepEqual(generic.writableToolAllowlist, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
assert.equal(generic.supportsWrite, true);
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npx tsx --test test/profile-discovery.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/profile-discovery.ts`.

- [ ] **Step 3: Implement explicit sanitization and DTO mapping**

Create `src/profile-discovery.ts`:

```ts
import { truncateUtf8 } from "./output.js";
import { getLaunchToolAllowlist } from "./profile-capabilities.js";
import type { AgentProfile } from "./types.js";

export interface PublicAgentProfile {
  name: string;
  description: string;
  source: "builtin" | "user";
  model: string | null;
  inheritsParentModel: boolean;
  readOnlyToolAllowlist: string[];
  writableToolAllowlist: string[];
  supportsWrite: boolean;
}

export function sanitizePublicText(value: string, maxBytes: number): string {
  const normalized = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return truncateUtf8(normalized, maxBytes).text.trim();
}

export function toPublicAgentProfile(profile: AgentProfile): PublicAgentProfile {
  const readOnlyToolAllowlist = getLaunchToolAllowlist(profile, "read-only")
    .map((tool) => sanitizePublicText(tool, 128));
  const writableToolAllowlist = getLaunchToolAllowlist(profile, "write")
    .map((tool) => sanitizePublicText(tool, 128));
  const model = profile.model ? sanitizePublicText(profile.model, 512) : null;

  return {
    name: sanitizePublicText(profile.name, 128),
    description: sanitizePublicText(profile.description, 512),
    source: profile.source,
    model,
    inheritsParentModel: model === null,
    readOnlyToolAllowlist,
    writableToolAllowlist,
    supportsWrite: writableToolAllowlist.some((tool) => tool === "bash" || tool === "edit" || tool === "write"),
  };
}
```

The fixed helper order supplies deduplication and count bounds for tool names; unsupported requested strings never cross the public boundary.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx tsx --test test/profile-capabilities.test.ts test/profile-discovery.test.ts
npm run typecheck
```

Expected: PASS with no private fields or control characters in the serialized DTO.

- [ ] **Step 5: Commit the public privacy boundary**

```bash
git add src/profile-discovery.ts test/profile-discovery.test.ts
git commit -m "feat: map safe public subagent profiles"
```

---

### Task 4: Bound model content and public details with whole-record omission

**Files:**
- Modify: `src/profile-discovery.ts`
- Modify: `test/profile-discovery.test.ts`

**Interfaces:**
- Consumes: `toPublicAgentProfile(profile)` from Task 3.
- Produces: `PUBLIC_DISCOVERY_MAX_BYTES`, `PublicAgentDiscovery`, and `buildPublicAgentDiscovery(profiles)`.
- `PublicAgentDiscovery` is exactly `{ profiles: PublicAgentProfile[]; omittedProfiles: number; content: string }`.
- Included records form one deterministic prefix and are identical in `content` and `profiles`.

- [ ] **Step 1: Write failing deterministic-format and byte-bound tests**

Append tests that call the new builder:

```ts
import {
  PUBLIC_DISCOVERY_MAX_BYTES,
  buildPublicAgentDiscovery,
  sanitizePublicText,
  toPublicAgentProfile,
} from "../src/profile-discovery.ts";

const sourceProfiles: AgentProfile[] = [
  { name: "generic", description: "Generic coding agent", systemPrompt: "private generic", source: "builtin" },
  { name: "reviewer", description: "Review changed code", systemPrompt: "private reviewer", source: "user", model: "anthropic/claude-sonnet-4-5", tools: ["grep", "read"] },
];

const discovery = buildPublicAgentDiscovery(sourceProfiles);
assert.deepEqual(discovery.profiles.map((entry) => entry.name), ["generic", "reviewer"]);
assert.equal(discovery.omittedProfiles, 0);
assert.match(discovery.content, /^Available subagent profiles:/);
assert.match(discovery.content, /reviewer — Review changed code/);
assert.match(discovery.content, /Configured model: anthropic\/claude-sonnet-4-5/);
assert.match(discovery.content, /Inherits parent model: no/);
assert.match(discovery.content, /Read-only launch allowlist: read, grep/);
assert.match(discovery.content, /Writable launch allowlist: read, grep/);
assert.match(discovery.content, /Supports write-capable tools: no/);
assert.doesNotMatch(discovery.content, /private generic|private reviewer/);
```

Add a large multibyte collection:

```ts
const many = Array.from({ length: 200 }, (_, index): AgentProfile => ({
  name: `agent-${index}-${"😀".repeat(40)}`,
  description: `Description ${index} ${"界".repeat(220)}`,
  systemPrompt: `SECRET-${index}`,
  source: index === 0 ? "builtin" : "user",
  model: `provider/${"模型".repeat(100)}`,
  tools: ["read", "grep", "bash", "write"],
}));
many[0] = { name: "generic", description: "Generic coding agent", systemPrompt: "GENERIC SECRET", source: "builtin" };

const bounded = buildPublicAgentDiscovery(many);
const detailsText = JSON.stringify({
  jobs: [],
  diagnostics: [],
  operation: "agents",
  profiles: bounded.profiles,
  omittedProfiles: bounded.omittedProfiles,
});
assert.ok(Buffer.byteLength(bounded.content, "utf8") <= PUBLIC_DISCOVERY_MAX_BYTES);
assert.ok(Buffer.byteLength(detailsText, "utf8") <= PUBLIC_DISCOVERY_MAX_BYTES);
assert.ok(bounded.omittedProfiles > 0);
assert.equal(bounded.profiles.length + bounded.omittedProfiles, many.length);
assert.match(bounded.content, new RegExp(`Omitted ${bounded.omittedProfiles} profile`));
assert.doesNotMatch(bounded.content, /SECRET|�/);
assert.doesNotMatch(detailsText, /SECRET|�/);
```

Finally, reconstruct each included entry's formatted name/description and assert it appears in content, proving content and details use the same records.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npx tsx --test test/profile-discovery.test.ts
```

Expected: FAIL because `PUBLIC_DISCOVERY_MAX_BYTES` and `buildPublicAgentDiscovery()` are not exported.

- [ ] **Step 3: Add complete-entry formatting**

Add to `src/profile-discovery.ts`:

```ts
export const PUBLIC_DISCOVERY_MAX_BYTES = 50 * 1024;

export interface PublicAgentDiscovery {
  profiles: PublicAgentProfile[];
  omittedProfiles: number;
  content: string;
}

const list = (tools: readonly string[]): string => tools.length === 0 ? "none" : tools.join(", ");

const formatPublicProfile = (profile: PublicAgentProfile): string => [
  `- ${profile.name} — ${profile.description}`,
  `  Source: ${profile.source}`,
  `  Configured model: ${profile.model ?? "none"}`,
  `  Inherits parent model: ${profile.inheritsParentModel ? "yes" : "no"}`,
  `  Read-only launch allowlist: ${list(profile.readOnlyToolAllowlist)}`,
  `  Writable launch allowlist: ${list(profile.writableToolAllowlist)}`,
  `  Supports write-capable tools: ${profile.supportsWrite ? "yes" : "no"}`,
].join("\n");

const omissionNotice = (count: number): string =>
  `Omitted ${count} profile${count === 1 ? "" : "s"} because discovery output is limited to 50 KiB.`;

const formatContent = (profiles: readonly PublicAgentProfile[], omittedProfiles: number): string => [
  "Available subagent profiles:",
  ...profiles.map(formatPublicProfile),
  ...(omittedProfiles > 0 ? [omissionNotice(omittedProfiles)] : []),
].join("\n");
```

- [ ] **Step 4: Select the longest complete prefix that fits both representations**

Implement the builder using the total profile count as the conservative omission-count reservation:

```ts
export function buildPublicAgentDiscovery(privateProfiles: readonly AgentProfile[]): PublicAgentDiscovery {
  const mapped = privateProfiles.map(toPublicAgentProfile);
  const profiles: PublicAgentProfile[] = [];

  for (const candidate of mapped) {
    const next = [...profiles, candidate];
    const allIncluded = next.length === mapped.length;
    const reservedOmitted = allIncluded ? 0 : mapped.length;
    const content = formatContent(next, reservedOmitted);
    const details = JSON.stringify({
      jobs: [],
      diagnostics: [],
      operation: "agents",
      profiles: next,
      omittedProfiles: reservedOmitted,
    });

    if (Buffer.byteLength(content, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES
      || Buffer.byteLength(details, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES) break;
    profiles.push(candidate);
  }

  const omittedProfiles = mapped.length - profiles.length;
  return { profiles, omittedProfiles, content: formatContent(profiles, omittedProfiles) };
}
```

This stops at the first non-fitting complete record, reserves enough bytes for the omission count before including each record, and never removes private profiles from the launch map.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
npx tsx --test test/profile-discovery.test.ts
npm run typecheck
```

Expected: PASS; both serialized forms are valid UTF-8, at most 50 KiB, and report omitted whole profiles.

- [ ] **Step 6: Commit bounded discovery formatting**

```bash
git add src/profile-discovery.ts test/profile-discovery.test.ts
git commit -m "feat: bound subagent profile discovery"
```

---

### Task 5: Register and render `subagent_agents`

**Files:**
- Modify: `src/tools.ts:5-63,142-203`
- Modify: `test/tools.test.ts:1-20,302-365,384-420,482-535`

**Interfaces:**
- Consumes: `buildPublicAgentDiscovery([...profiles.values()])` from Task 4 and existing `ToolServices.getProfiles()`.
- Produces: `AgentsParams`, `AgentsInput`, `AgentsToolResponse`, `listAgents(services)`, and the registered `subagent_agents` tool.
- Extends `ToolDetails.operation` with `"agents"` and adds optional `profiles?: PublicAgentProfile[]` and `omittedProfiles?: number`; discovery responses use `jobs: []` and `diagnostics: []`.

- [ ] **Step 1: Write failing execution and sensitive-data tests**

Update imports in `test/tools.test.ts` to include `AgentsParams` and `listAgents`. Add:

```ts
test("listAgents returns bounded public profiles without private discovery data", async () => {
  const secretProfile: AgentProfile = {
    name: "reviewer",
    description: "Review changed code",
    systemPrompt: "SECRET PROMPT",
    source: "user",
    model: "anthropic/sonnet",
    tools: ["read", "grep"],
    filePath: "/secret/agents/reviewer.md",
  };
  const { services } = createServices(undefined, {
    getProfiles: async () => new Map([
      ["generic", { ...profile, name: "generic", description: "Generic coding agent", source: "builtin" as const }],
      ["reviewer", secretProfile],
    ]),
  });

  const result = await listAgents(services);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.details.profiles?.map((entry) => entry.name), ["generic", "reviewer"]);
  assert.equal(result.details.omittedProfiles, 0);
  assert.match(text(result), /Available subagent profiles/);
  assert.match(text(result), /reviewer — Review changed code/);
  assert.doesNotMatch(serialized, /SECRET PROMPT|\/secret\/agents|systemPrompt|filePath/);
  assert.deepEqual(result.details.jobs, []);
  assert.deepEqual(result.details.diagnostics, []);
});
```

Add a runtime assertion to the existing session-start test: retrieve `pi.tools.get("subagent_agents")`, execute it after profile discovery, and assert it lists the loaded `writer` profile but not `profile warning`. This proves UI-only discovery diagnostics do not enter model content/details.

- [ ] **Step 2: Write failing schema, description, and renderer tests**

In the registered-tools test, assert:

```ts
const agentsSchema = AgentsParams as unknown as {
  type: string;
  properties: Record<string, unknown>;
  additionalProperties: boolean;
};
assert.equal(agentsSchema.type, "object");
assert.deepEqual(agentsSchema.properties, {});
assert.equal(agentsSchema.additionalProperties, false);
assert.match(pi.tools.get("subagent_agents")?.description ?? "", /only when.*unknown/i);
assert.match(pi.tools.get("subagent_agents")?.description ?? "", /launch allowlist.*not.*authorization/i);
```

Add compact and expanded render assertions using the result from `listAgents()`:

```ts
const compact = render("subagent_agents", result, false);
assert.match(compact, /Available subagent profiles:/);
assert.match(compact, /- generic — Generic coding agent/);
assert.match(compact, /- reviewer — Review changed code/);
assert.doesNotMatch(compact, /Configured model|launch allowlist/);

const expanded = render("subagent_agents", result, true);
assert.match(expanded, /reviewer — Review changed code/);
assert.match(expanded, /Model: anthropic\/sonnet/);
assert.match(expanded, /Read-only launch allowlist: read, grep/);
assert.match(expanded, /Writable launch allowlist: read, grep/);
assert.match(expanded, /Supports write-capable tools: no/);
```

- [ ] **Step 3: Run tools tests to verify RED**

Run:

```bash
npx tsx --test test/tools.test.ts
```

Expected: FAIL because the schema, execution function, details fields, registration, and renderer do not exist.

- [ ] **Step 4: Add the empty schema and discovery response**

In `src/tools.ts`, import the public builder/type and define:

```ts
import { buildPublicAgentDiscovery, type PublicAgentProfile } from "./profile-discovery.js";

export const AgentsParams = Type.Object({}, { additionalProperties: false });
export type AgentsInput = Static<typeof AgentsParams>;
```

Extend details:

```ts
export interface ToolDetails {
  jobs: Job[];
  diagnostics: string[];
  operation?: "agents" | "start" | "status" | "wait" | "cancel" | "collect" | "discard";
  profiles?: PublicAgentProfile[];
  omittedProfiles?: number;
}
```

Add a narrowed response type so Plan 02's wait-details union stays type-safe, then add execution:

```ts
export interface AgentsToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails & {
    operation: "agents";
    profiles: PublicAgentProfile[];
    omittedProfiles: number;
  };
}

export async function listAgents(services: ToolServices): Promise<AgentsToolResponse> {
  const profiles = await services.getProfiles();
  const discovery = buildPublicAgentDiscovery([...profiles.values()]);
  return {
    content: [{ type: "text", text: discovery.content }],
    details: {
      jobs: [],
      diagnostics: [],
      operation: "agents",
      profiles: discovery.profiles,
      omittedProfiles: discovery.omittedProfiles,
    },
  };
}
```

- [ ] **Step 5: Add compact and expanded profile rendering**

Add a dedicated renderer rather than adding profile branches throughout the job renderer:

```ts
const renderAgentProfiles = (
  result: AgentsToolResponse,
  expanded: boolean,
  theme: { fg(color: string, text: string): string },
): string => {
  const profiles = result.details.profiles ?? [];
  const omitted = result.details.omittedProfiles ?? 0;
  const compact = [
    "Available subagent profiles:",
    ...profiles.map((profile) => `- ${profile.name} — ${profile.description}`),
    ...(omitted > 0 ? [`- ${omitted} additional profile${omitted === 1 ? "" : "s"} omitted`] : []),
  ].join("\n");
  if (!expanded) return theme.fg("muted", compact);

  const detail = profiles.map((profile) => [
    `${profile.name} — ${profile.description}`,
    `  Model: ${profile.model ?? "parent model (inherited)"}`,
    `  Read-only launch allowlist: ${profile.readOnlyToolAllowlist.join(", ") || "none"}`,
    `  Writable launch allowlist: ${profile.writableToolAllowlist.join(", ") || "none"}`,
    `  Supports write-capable tools: ${profile.supportsWrite ? "yes" : "no"}`,
  ].join("\n")).join("\n\n");
  return theme.fg("muted", [compact, detail].filter(Boolean).join("\n\n"));
};
```

- [ ] **Step 6: Register the tool with selection guidance**

Add the registration before `subagent_start`:

```ts
pi.registerTool({
  name: "subagent_agents",
  label: "Subagent Profiles",
  description: "List available subagent profile names and safe public capabilities. Call only when profile names or capabilities are unknown, not before every job. Launch allowlists are requested child Pi tools, not write authorization or a runtime sandbox.",
  parameters: AgentsParams,
  execute: async () => listAgents(services),
  renderCall: (_input, theme) => new Text(theme.fg("toolTitle", "subagent_agents"), 0, 0),
  renderResult: (result, { expanded }, theme) =>
    new Text(renderAgentProfiles(result as AgentsToolResponse, expanded, theme), 0, 0),
});
```

- [ ] **Step 7: Run focused and registration tests**

Run:

```bash
npx tsx --test test/profile-discovery.test.ts test/tools.test.ts
npm run typecheck
```

Expected: PASS; compact output has names/descriptions only, expanded output has model/capabilities, model-visible content/details contain no private fields or diagnostics, and all `subagent_wait` tests remain green.

- [ ] **Step 8: Commit the discovery tool**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: add subagent profile discovery tool"
```

---

### Task 6: Format bounded unknown-profile diagnostics

**Files:**
- Modify: `src/profile-discovery.ts`
- Modify: `test/profile-discovery.test.ts`

**Interfaces:**
- Produces: `formatUnknownProfileDiagnostic(unknownName: string, profiles: readonly AgentProfile[]): string`.
- Consumes: the same `sanitizePublicText(name, 128)` boundary used by discovery.

- [ ] **Step 1: Write the failing pure formatter test**

Append to `test/profile-discovery.test.ts`:

```ts
import { formatUnknownProfileDiagnostic } from "../src/profile-discovery.ts";

test("unknown-profile diagnostics sanitize names and bound the available list", () => {
  const profiles = Array.from({ length: 600 }, (_, index): AgentProfile => ({
    name: `agent-${index}\n${"😀".repeat(50)}`,
    description: "private description",
    systemPrompt: `SECRET-${index}`,
    source: index === 0 ? "builtin" : "user",
  }));
  profiles[0] = { name: "generic", description: "Generic coding agent", systemPrompt: "secret", source: "builtin" };

  const diagnostic = formatUnknownProfileDiagnostic(` reveiwer\n\u0000${"界".repeat(100)} `, profiles);

  assert.ok(Buffer.byteLength(diagnostic, "utf8") <= PUBLIC_DISCOVERY_MAX_BYTES);
  assert.match(diagnostic, /^Unknown agent profile: reveiwer /);
  assert.match(diagnostic, /Available profiles: generic, agent-1 /);
  assert.match(diagnostic, /profile names omitted\.$/);
  assert.doesNotMatch(diagnostic, /[\u0000-\u001f\u007f]|SECRET|�/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx tsx --test --test-name-pattern="unknown-profile diagnostics sanitize" test/profile-discovery.test.ts
```

Expected: FAIL because the formatter does not exist.

- [ ] **Step 3: Implement the bounded formatter**

Add to `src/profile-discovery.ts`:

```ts
export function formatUnknownProfileDiagnostic(
  unknownName: string,
  privateProfiles: readonly AgentProfile[],
): string {
  const unknown = sanitizePublicText(unknownName, 128);
  const prefix = `Unknown agent profile: ${unknown}. Available profiles: `;
  const names: string[] = [];

  for (const profile of privateProfiles) {
    const name = sanitizePublicText(profile.name, 128);
    const nextNames = [...names, name];
    const allIncluded = nextNames.length === privateProfiles.length;
    const reservedOmitted = allIncluded ? 0 : privateProfiles.length;
    const suffix = reservedOmitted > 0 ? `, ${reservedOmitted} profile names omitted.` : ".";
    const candidate = `${prefix}${nextNames.join(", ")}${suffix}`;
    if (Buffer.byteLength(candidate, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES) break;
    names.push(name);
  }

  const omitted = privateProfiles.length - names.length;
  const suffix = omitted > 0 ? `, ${omitted} profile names omitted.` : ".";
  return `${prefix}${names.join(", ")}${suffix}`;
}
```

Do not inspect discovery diagnostics or perform fuzzy matching.

- [ ] **Step 4: Run profile tests and typecheck**

```bash
npx tsx --test test/profile-discovery.test.ts
npm run typecheck
```

Expected: PASS with sanitized UTF-8 output at or below 50 KiB.

- [ ] **Step 5: Commit the pure diagnostic formatter**

```bash
git add src/profile-discovery.ts test/profile-discovery.test.ts
git commit -m "feat: format bounded profile errors"
```

---

### Task 7: Use actionable diagnostics during start validation

**Files:**
- Modify: `src/tools.ts:67-80`
- Modify: `test/tools.test.ts:154-163`

**Interfaces:**
- Consumes: `formatUnknownProfileDiagnostic()` from Task 6.
- Preserves: atomic batch rejection before write confirmation, enqueueing, or job-ID allocation.

- [ ] **Step 1: Write failing start-tool assertions**

Update the existing unknown-profile test to expect:

```ts
const expected = "Unknown agent profile: missing. Available profiles: generic, reviewer.";
assert.equal(text(result), expected);
assert.deepEqual(result.details.diagnostics, [expected]);
assert.deepEqual(result.details.jobs, []);
assert.equal(runner.started.length, 0);
```

Add a second case with `agent: "bad\nname"` and assert neither model-visible content nor details contains a line break from that name.

- [ ] **Step 2: Run the focused tool test and verify RED**

```bash
npx tsx --test --test-name-pattern="unknown profile" test/tools.test.ts
```

Expected: FAIL because start validation still emits only the raw unknown name.

- [ ] **Step 3: Call the formatter during batch prevalidation**

Replace the current unknown-profile block in `startJobs()` with:

```ts
const unknown = requests.find((request) => !profiles.has(request.agent));
if (unknown) {
  const diagnostic = formatUnknownProfileDiagnostic(unknown.agent, [...profiles.values()]);
  return response(diagnostic, [], [diagnostic], "start");
}
```

Import the formatter beside the discovery builder. Keep this block before writable confirmation and `manager.enqueue()`.

- [ ] **Step 4: Run tool and regression tests**

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
npm run test:unit
```

Expected: PASS, including existing wait and profile-discovery tools.

- [ ] **Step 5: Commit start validation integration**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: list valid subagent profiles in errors"
```

---

### Task 8: Document profile discovery and capability semantics

**Files:**
- Modify: `README.md:30-50`

**Interfaces:**
- Documents the registered `subagent_agents({})` interface and existing profile frontmatter.
- Distinguishes launch capability, per-job authorization, extension-altered runtime tools, and private fields.

- [ ] **Step 1: Add the discovery documentation after the profile example**

Insert this text in `README.md` before the existing “Jobs are read-only by default” paragraph:

```md
Use `subagent_agents({})` when profile names or capabilities are unknown. It returns profiles in discovery order (built-in `generic` first), including configured model inheritance and the read-only and writable tool allowlists passed when child Pi starts. These are launch ceilings, not guarantees of effective runtime tools: trusted child extensions may alter active tools.

A writable launch allowlist does not authorize a job to write. The parent must still start that job with `writeAccess: true`, and configured write confirmation still applies. Discovery never returns profile system prompts, profile file paths, raw frontmatter, discovery diagnostics, credentials, or parent session context.
```

- [ ] **Step 2: Verify the documented names and privacy boundary**

Run:

```bash
grep -n "subagent_agents\|launch ceilings\|writeAccess\|system prompts" README.md
```

Expected: output includes all four concepts in the new “Agents and access” documentation.

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
npm test
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 4: Inspect the final diff for the sensitive-data boundary**

Run:

```bash
git diff --check
git diff -- src/profile-capabilities.ts src/profile-discovery.ts src/process-runner.ts src/tools.ts README.md test/profile-capabilities.test.ts test/profile-discovery.test.ts test/process-runner.test.ts test/tools.test.ts
```

Expected: no whitespace errors; public DTO construction lists fields explicitly; no spread of private profiles enters tool content/details; no new dependency, configuration, persistence, fuzzy matching, or project profile behavior appears.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain subagent profile discovery"
```
