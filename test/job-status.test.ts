import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { boundedPreview, formatSingleJobStatus, projectJobStatus, sanitizeTerminalText, selectStatusList } from "../src/job-status.js";
import type { Job, JobState } from "../src/types.js";

test("removes unsafe terminal controls while optionally retaining SGR", () => {
  const hostile = "ok\rreplace\t😀 e\u0301 漢\u001B]0;owned\u0007\u001B[2J\u001B[H\u001B[K\u001B[31mred\u001B[0m";
  const plain = sanitizeTerminalText(hostile);
  const styled = sanitizeTerminalText(hostile, true);
  assert.doesNotMatch(plain, /\r|\t|\u001B|\u0007/);
  assert.doesNotMatch(styled, /\u001B\](?:.|\n)*|\u001B\[(?:2J|H|K)/);
  assert.match(styled, /\u001B\[31mred\u001B\[0m/);
});

test("bounds previews on grapheme and UTF-8 boundaries", () => {
  const value = boundedPreview("😀".repeat(400), 511, 400);
  assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
  assert.ok(Buffer.byteLength(value, "utf8") <= 511);
  assert.equal(boundedPreview("a\tb\r\nc", 100, 100), "a b c");
});

const job = (state: JobState, overrides: Partial<Job> = {}): Job => ({
  id: "job-1",
  request: { task: "Review the final branch", agent: "reviewer", writeAccess: false },
  profile: { name: "reviewer", description: "Reviews changes", systemPrompt: "private prompt", source: "user" },
  state,
  createdAt: 1_000,
  startedAt: state === "queued" ? undefined : 2_000,
  finishedAt: state === "completed" || state === "failed" || state === "cancelled" || state === "collected" || state === "discarded" ? 7_000 : undefined,
  progress: [],
  output: "secret complete answer",
  stderr: "secret stderr",
  errorMessage: "secret error",
  malformedEventCount: 1,
  malformedEventSamples: ["secret malformed sample"],
  usage: { input: 1_000, output: 500, cacheRead: 20, cacheWrite: 10, cost: 0.25, turns: 3 },
  ...overrides,
});

test("projects queue, running, and final durations with one injected clock", () => {
  const queued = projectJobStatus(job("queued"), 6_000);
  const running = projectJobStatus(job("running"), 6_000);
  const completed = projectJobStatus(job("completed"), 10_000);
  assert.equal(queued.queueDurationMs, 5_000);
  assert.equal(queued.runDurationMs, undefined);
  assert.equal(running.queueDurationMs, 1_000);
  assert.equal(running.runDurationMs, 4_000);
  assert.equal(completed.queueDurationMs, 1_000);
  assert.equal(completed.runDurationMs, 5_000);
});

test("projects a terminal queued job duration from creation to finish", () => {
  const cancelled = projectJobStatus(job("cancelled", { startedAt: undefined, finishedAt: 7_000 }), 10_000);

  assert.equal(cancelled.queueDurationMs, 6_000);
  assert.equal(cancelled.runDurationMs, undefined);
});

test("selects three chronological activity previews and caps grouped status", () => {
  const status = projectJobStatus(job("running", { progress: [
    { type: "tool", text: "Started read", timestamp: 2_100 },
    { type: "tool", text: "Completed read", timestamp: 2_200 },
    { type: "diagnostic", text: "Checking diagnostics in src/auth.ts", timestamp: 2_300 },
    { type: "text", text: "Reviewing the final branch", timestamp: 2_400 },
  ] }), 2_500);
  assert.deepEqual(status.recentActivity.map((item) => item.timestamp), [2_200, 2_300, 2_400]);
  assert.deepEqual(status.recentActivity.map((item) => item.kind), ["tool", "diagnostic", "assistant"]);
  for (const item of status.recentActivity) assert.ok(Buffer.byteLength(item.summary, "utf8") <= 512);
  const selected = selectStatusList(Array.from({ length: 25 }, (_, index) => job(index % 3 === 0 ? "running" : index % 3 === 1 ? "completed" : "collected", { id: `job-${index + 1}` })), 10_000);
  assert.equal(selected.statuses.length, 20);
  assert.equal(selected.omitted, 5);
  assert.deepEqual(selected.statuses.slice(0, 2).map((item) => item.state), ["running", "running"]);
});

test("formatters expose facts but exclude all captured and private fields", () => {
  const text = formatSingleJobStatus(projectJobStatus(job("failed"), 8_000), 8_000);
  assert.match(text, /job-1.*failed/);
  assert.match(text, /Result ready/);
  assert.doesNotMatch(text, /secret complete answer|secret stderr|secret error|secret malformed sample|private prompt/);
  assert.ok(Buffer.byteLength(text, "utf8") < 50 * 1024);
});
