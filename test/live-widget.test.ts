import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatLiveWidgetLines } from "../src/live-widget.js";
import type { Job, JobState } from "../src/types.js";

const colorCodes: Record<string, number> = { accent: 35, dim: 2, error: 31, muted: 90, success: 32 };
const theme = {
  fg: (color: string, text: string) => `\u001B[${colorCodes[color] ?? 37}m${text}\u001B[0m`,
  bold: (text: string) => `\u001B[1m${text}\u001B[0m`,
} as never;

const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*m/gu, "");

const job = (id: string, state: JobState, overrides: Partial<Job> = {}): Job => ({
  id,
  request: { task: `Task ${id}`, agent: "reviewer", writeAccess: false },
  profile: { name: "reviewer", description: "Reviews", systemPrompt: "Review.", source: "user" },
  state,
  createdAt: 1_000,
  startedAt: state === "running" || ["completed", "failed", "cancelled"].includes(state) ? 2_000 : undefined,
  finishedAt: ["completed", "failed", "cancelled", "collected", "discarded"].includes(state) ? 8_000 : undefined,
  progress: [],
  output: "",
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  malformedEventCount: 0,
  ...overrides,
});

const render = (jobs: readonly Job[], now = 10_000, frame = 0, width = 120): string[] =>
  formatLiveWidgetLines(jobs, { now, frame, width, theme });

test("renders active jobs in running, queued, then lingering order", () => {
  const lines = render([
    job("done", "completed"),
    job("queued", "queued"),
    job("running", "running", {
      progress: [{ type: "tool", text: "Started read", timestamp: 9_000 }],
    }),
    job("old", "failed", { finishedAt: 6_999 }),
    job("collected", "collected"),
    job("discarded", "discarded"),
  ]);
  const text = lines.map(plain);

  assert.equal(text[0], "● Subagents");
  assert.match(text[1] ?? "", /^├─ ⠋ reviewer  Task running/);
  assert.equal(text[2], "│    ⎿ Started read");
  assert.match(text[3] ?? "", /^├─ ○ reviewer  Task queued/);
  assert.match(text[4] ?? "", /^└─ ✓ reviewer  Task done/);
  assert.equal(text.some((line) => /old|collected|discarded/u.test(line)), false);
});

test("renders terminal icons and a dim heading when only lingered jobs remain", () => {
  const text = render([
    job("ok", "completed"),
    job("bad", "failed"),
    job("stop", "cancelled"),
  ]).map(plain);

  assert.equal(text[0], "○ Subagents");
  assert.match(text[1] ?? "", /^├─ ✓/);
  assert.match(text[2] ?? "", /^├─ ✗/);
  assert.match(text[3] ?? "", /^└─ ■/);
  const raw = render([job("ok", "completed"), job("bad", "failed"), job("stop", "cancelled")]);
  assert.match(raw[1] ?? "", /\u001B\[32m✓/u);
  assert.match(raw[2] ?? "", /\u001B\[31m✗/u);
  assert.match(raw[3] ?? "", /\u001B\[2m■/u);
});

test("uses thinking fallback and removes the final activity continuation", () => {
  const text = render([job("running", "running")]).map(plain);
  assert.match(text[1] ?? "", /^└─ ⠋/);
  assert.equal(text[2], "     ⎿ thinking…");
});

test("selects and wraps spinner frames", () => {
  assert.match(plain(render([job("running", "running")], 10_000, 2)[1] ?? ""), /⠹/);
  assert.match(plain(render([job("running", "running")], 10_000, 12)[1] ?? ""), /⠹/);
});

test("lingers before but not at the exact three-second boundary", () => {
  const finished = job("done", "completed", { finishedAt: 8_000 });
  assert.notDeepEqual(render([finished], 10_999), []);
  assert.deepEqual(render([finished], 11_000), []);
});

test("clamps skewed durations and bounds every visible line", () => {
  const jobs = [job("future", "running", {
    startedAt: 20_000,
    request: { task: "A very long task name with emoji 😀 and CJK 漢字", agent: "reviewer", writeAccess: false },
  })];
  assert.match(plain(render(jobs, 10_000, 0, 120)[1] ?? ""), /0\.0s$/);
  for (const width of [1, 4, 8, 20, 40, 120]) {
    for (const line of render(jobs, 10_000, 0, width)) assert.ok(visibleWidth(line) <= width);
  }
});

test("formats turns, started tool uses, tokens, and duration", () => {
  const text = plain(render([job("running", "running", {
    usage: { input: 12_000, output: 400, cacheRead: 9_000, cacheWrite: 8_000, cost: 1, turns: 2 },
    progress: [
      { type: "tool", text: "Started read", timestamp: 3_000 },
      { type: "tool", text: "Updated read", timestamp: 4_000 },
      { type: "tool", text: "Completed read", timestamp: 5_000 },
      { type: "tool", text: "Started bash", timestamp: 6_000 },
    ],
  })])[1] ?? "");

  assert.match(text, /↻2 · 2 tool uses · 12\.4k tokens · 8\.0s$/);
});

test("uses singular stat labels and compact million tokens", () => {
  const text = plain(render([job("running", "running", {
    usage: { input: 1_200_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    progress: [{ type: "tool", text: "Started read", timestamp: 3_000 }],
  })])[1] ?? "");
  assert.match(text, /↻1 · 1 tool use · 1\.2M tokens/);
});
