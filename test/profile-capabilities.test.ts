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
