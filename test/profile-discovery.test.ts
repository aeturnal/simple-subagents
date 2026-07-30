import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_DISCOVERY_MAX_BYTES,
  buildPublicAgentDiscovery,
  sanitizePublicText,
  toPublicAgentProfile,
} from "../src/profile-discovery.ts";
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

test("generic profiles expose fixed launch capabilities", () => {
  const generic = toPublicAgentProfile({
    name: "generic",
    description: "Generic coding agent",
    systemPrompt: "private",
    source: "builtin",
  });

  assert.deepEqual(generic.readOnlyToolAllowlist, ["read", "grep", "find", "ls"]);
  assert.deepEqual(generic.writableToolAllowlist, ["read", "grep", "find", "ls", "bash", "edit", "write"]);
  assert.equal(generic.supportsWrite, true);
});

test("formats deterministic public discovery without private profile fields", () => {
  const sourceProfiles: AgentProfile[] = [
    { name: "generic", description: "Generic coding agent", systemPrompt: "private generic", source: "builtin" },
    {
      name: "reviewer",
      description: "Review changed code",
      systemPrompt: "private reviewer",
      source: "user",
      model: "anthropic/claude-sonnet-4-5",
      tools: ["grep", "read"],
    },
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
});

test("keeps a decimal-width boundary record when its exact omission count fits", () => {
  const maximumProfile = (index: number): AgentProfile => ({
    name: `a${index}${"n".repeat(120)}`,
    description: "d".repeat(512),
    systemPrompt: `SECRET-${index}`,
    source: "user",
    model: `p/${"m".repeat(500)}`,
    tools: ["read", "grep", "bash", "write"],
  });
  const profiles = Array.from({ length: 100 }, (_, index) => maximumProfile(index));
  profiles[37] = { ...maximumProfile(37), description: "x".repeat(365) };

  const discovery = buildPublicAgentDiscovery(profiles);
  const detailsText = JSON.stringify({
    jobs: [],
    diagnostics: [],
    operation: "agents",
    profiles: discovery.profiles,
    omittedProfiles: discovery.omittedProfiles,
  });

  assert.equal(discovery.profiles.length, 38);
  assert.equal(discovery.omittedProfiles, 62);
  assert.ok(Buffer.byteLength(discovery.content, "utf8") <= PUBLIC_DISCOVERY_MAX_BYTES);
  assert.ok(Buffer.byteLength(detailsText, "utf8") <= PUBLIC_DISCOVERY_MAX_BYTES);

  const firstOmittedProfile = profiles[discovery.profiles.length];
  assert.ok(firstOmittedProfile);
  const nextProfiles = [...discovery.profiles, toPublicAgentProfile(firstOmittedProfile)];
  const nextOmittedProfiles = profiles.length - nextProfiles.length;
  const nextContent = [
    "Available subagent profiles:",
    ...nextProfiles.map((profile) => [
      `- ${profile.name} — ${profile.description}`,
      `  Source: ${profile.source}`,
      `  Configured model: ${profile.model ?? "none"}`,
      `  Inherits parent model: ${profile.inheritsParentModel ? "yes" : "no"}`,
      `  Read-only launch allowlist: ${profile.readOnlyToolAllowlist.join(", ") || "none"}`,
      `  Writable launch allowlist: ${profile.writableToolAllowlist.join(", ") || "none"}`,
      `  Supports write-capable tools: ${profile.supportsWrite ? "yes" : "no"}`,
    ].join("\n")),
    `Omitted ${nextOmittedProfiles} profiles because discovery output is limited to 50 KiB.`,
  ].join("\n");
  const nextDetailsText = JSON.stringify({
    jobs: [],
    diagnostics: [],
    operation: "agents",
    profiles: nextProfiles,
    omittedProfiles: nextOmittedProfiles,
  });

  assert.ok(
    Buffer.byteLength(nextContent, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES
      || Buffer.byteLength(nextDetailsText, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES,
  );
});

test("bounds both discovery representations using one whole-record prefix", () => {
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

  for (const entry of bounded.profiles) {
    assert.match(bounded.content, new RegExp(`- ${entry.name} — ${entry.description}`));
  }
});
