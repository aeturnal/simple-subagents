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
