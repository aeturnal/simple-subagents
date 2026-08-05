import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatLiveWidgetLines, LiveSubagentsWidget } from "../src/live-widget.js";
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
    job("old", "failed", { finishedAt: 4_999 }),
    job("collected", "collected"),
    job("discarded", "discarded"),
  ]);
  const text = lines.map(plain);

  assert.equal(text[0], "● Subagents");
  assert.match(text[1] ?? "", /^├─ ⠋ reviewer {2}Task running/);
  assert.equal(text[2], "│    ⎿ Started read");
  assert.match(text[3] ?? "", /^├─ ○ reviewer {2}Task queued/);
  assert.match(text[4] ?? "", /^└─ ✓ reviewer {2}Task done/);
  assert.equal(text.some((line) => /old|collected|discarded/u.test(line)), false);
});

test("preserves input order inside running, queued, and lingering groups", () => {
  const rows = render([
    job("done-first", "completed"),
    job("queued-first", "queued"),
    job("running-first", "running"),
    job("done-second", "failed"),
    job("queued-second", "queued"),
    job("running-second", "running"),
  ]).map(plain).filter((line) => line.includes("Task "));

  assert.deepEqual(rows.map((line) => line.match(/Task ([a-z-]+)/u)?.[1]), [
    "running-first",
    "running-second",
    "queued-first",
    "queued-second",
    "done-first",
    "done-second",
  ]);
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

test("renders the latest model activity for a running job", () => {
  const text = render([job("running", "running", {
    progress: [{ type: "model", text: "Model reasoning", timestamp: 9_500 }],
  })]).map(plain);

  assert.equal(text[2], "     ⎿ Model reasoning");
});

test("uses thinking fallback and removes the final activity continuation", () => {
  const text = render([job("running", "running")]).map(plain);
  assert.match(text[1] ?? "", /^└─ ⠋/);
  assert.equal(text[2], "     ⎿ thinking…");
});

test("shows the selected thinking level without source detail in a compact row", () => {
  const row = plain(render([job("running", "running", {
    launchThinkingLevel: "medium",
    launchThinkingSource: "profile",
  })])[1] ?? "");

  assert.match(row, /medium/);
  assert.doesNotMatch(row, /profile/);
});

test("selects and wraps spinner frames", () => {
  assert.match(plain(render([job("running", "running")], 10_000, 2)[1] ?? ""), /⠹/);
  assert.match(plain(render([job("running", "running")], 10_000, 12)[1] ?? ""), /⠹/);
});

test("lingers before but not at the exact five-second boundary", () => {
  const finished = job("done", "completed", { finishedAt: 8_000 });
  assert.notDeepEqual(render([finished], 12_999), []);
  assert.deepEqual(render([finished], 13_000), []);
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
    model: "openai-codex/gpt-5.6-sol",
    launchModel: "openai-codex/gpt-5.6-terra",
    launchThinkingLevel: "high",
    progress: [
      { type: "tool", text: "Started read", timestamp: 3_000 },
      { type: "tool", text: "Updated read", timestamp: 4_000 },
      { type: "tool", text: "Completed read", timestamp: 5_000 },
      { type: "tool", text: "Started bash", timestamp: 6_000 },
    ],
  })])[1] ?? "");

  assert.match(text, /↻2 · 2 tool uses · 12\.4k tokens · gpt-5\.6-sol · high · 8\.0s$/);
});

test("uses the short observed model then falls back to the launch model", () => {
  const observed = plain(render([job("observed", "running", {
    model: "openai-codex/gpt-5.6-sol",
    launchModel: "openai-codex/gpt-5.6-terra",
  })])[1] ?? "");
  const launch = plain(render([job("launch", "running", {
    launchModel: "openai-codex/gpt-5.6-terra",
  })])[1] ?? "");

  assert.match(observed, /gpt-5\.6-sol · 8\.0s$/);
  assert.match(launch, /gpt-5\.6-terra · 8\.0s$/);
});

test("truncates the task before the complete detail suffix", () => {
  const rich = job("wide", "running", {
    request: { task: "A very long task with emoji 😀 and CJK 漢字 that must shrink", agent: "reviewer", writeAccess: false },
    usage: { input: 12_000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
    progress: [{ type: "tool", text: "Started read", timestamp: 3_000 }],
    model: "openai-codex/gpt-5.6-sol",
    launchThinkingLevel: "high",
  });
  const suffix = "· ↻2 · 1 tool use · 12.4k tokens · gpt-5.6-sol · high · 8.0s";
  const prefix = "└─ ⠋ reviewer";
  const width = visibleWidth(prefix) + 2 + 12 + 1 + visibleWidth(suffix);
  const row = plain(render([rich], 10_000, 0, width)[1] ?? "");
  const noTask = plain(render([rich], 10_000, 0, visibleWidth(prefix) + 2 + visibleWidth(suffix))[1] ?? "");
  const extreme = plain(render([rich], 10_000, 0, visibleWidth(prefix) + 18)[1] ?? "");

  assert.equal(row.endsWith(suffix), true);
  assert.match(row, /A very lo\.\.\. · ↻2/);
  assert.equal(noTask, `${prefix}  ${suffix}`);
  assert.equal(extreme.endsWith("high · 8.0s"), true);
  assert.equal(visibleWidth(extreme) <= visibleWidth(prefix) + 18, true);
});

test("uses singular stat labels and compact million tokens", () => {
  const text = plain(render([job("running", "running", {
    usage: { input: 1_200_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    progress: [{ type: "tool", text: "Started read", timestamp: 3_000 }],
  })])[1] ?? "");
  assert.match(text, /↻1 · 1 tool use · 1\.2M tokens/);
});

class FakeClock {
  now = 10_000;
  nextId = 1;
  intervals = new Map<number, { callback(): void; delay: number }>();
  timeouts = new Map<number, { callback(): void; delay: number }>();
  setInterval = (callback: () => void, delay: number): unknown => {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  };
  clearInterval = (handle: unknown): void => { this.intervals.delete(handle as number); };
  setTimeout = (callback: () => void, delay: number): unknown => {
    const id = this.nextId++;
    this.timeouts.set(id, {
      callback: () => { this.timeouts.delete(id); callback(); },
      delay,
    });
    return id;
  };
  clearTimeout = (handle: unknown): void => { this.timeouts.delete(handle as number); };
}

class WidgetHarness {
  readonly clock = new FakeClock();
  readonly widgets: unknown[] = [];
  renderRequests = 0;
  factory: ((tui: any, theme: any) => { render(width: number): string[] }) | undefined;
  readonly ui = {
    setWidget: (_key: string, content: unknown) => {
      this.widgets.push(content);
      if (typeof content === "function") this.factory = content as typeof this.factory;
      if (content === undefined) this.factory = undefined;
    },
  };
  create() {
    const widget = new LiveSubagentsWidget({
      now: () => this.clock.now,
      setInterval: this.clock.setInterval,
      clearInterval: this.clock.clearInterval,
      setTimeout: this.clock.setTimeout,
      clearTimeout: this.clock.clearTimeout,
    });
    widget.setUi(this.ui as never);
    return widget;
  }
  render(width = 120): string[] {
    return this.factory?.({ requestRender: () => { this.renderRequests += 1; }, terminal: { columns: width } }, theme)?.render(width) ?? [];
  }
}

test("registers once and animates running jobs through requestRender", () => {
  const h = new WidgetHarness();
  const widget = h.create();
  widget.setJobs([job("run", "running")]);
  assert.equal(h.widgets.filter((entry) => typeof entry === "function").length, 1);
  assert.equal(h.clock.intervals.size, 1);
  assert.equal([...h.clock.intervals.values()][0]?.delay, 80);

  assert.match(plain(h.render()[1] ?? ""), /⠋/);
  const interval = [...h.clock.intervals.values()][0]!;
  interval.callback();
  assert.equal(h.renderRequests, 1);
  assert.match(plain(h.render()[1] ?? ""), /⠙/);

  widget.setJobs([job("run", "running", {
    progress: [{ type: "text", text: "new streamed text", timestamp: 10_000 }],
  })]);
  assert.equal(h.widgets.filter((entry) => typeof entry === "function").length, 1);
  assert.equal(h.renderRequests, 1);
  assert.match(plain(h.render()[2] ?? ""), /new streamed text/);
});

test("stops animation and expires terminal rows at the nearest deadline", () => {
  const h = new WidgetHarness();
  const widget = h.create();
  widget.setJobs([job("run", "running")]);
  h.render();

  widget.setJobs([
    job("first", "completed", { finishedAt: 8_000 }),
    job("second", "failed", { finishedAt: 9_000 }),
  ]);
  assert.equal(h.clock.intervals.size, 0);
  assert.equal(h.clock.timeouts.size, 1);
  assert.equal([...h.clock.timeouts.values()][0]?.delay, 3_000);

  h.clock.now = 13_000;
  [...h.clock.timeouts.values()][0]!.callback();
  assert.equal(h.clock.timeouts.size, 1);
  assert.equal([...h.clock.timeouts.values()][0]?.delay, 1_000);
  assert.equal(plain(h.render().join("\n")).includes("first"), false);
  assert.equal(plain(h.render().join("\n")).includes("second"), true);

  h.clock.now = 14_000;
  [...h.clock.timeouts.values()][0]!.callback();
  assert.equal(h.clock.timeouts.size, 0);
  assert.equal(h.factory, undefined);
});

test("removes a collected linger row immediately", () => {
  const h = new WidgetHarness();
  const widget = h.create();
  widget.setJobs([job("done", "completed")]);
  h.render();
  widget.setJobs([job("done", "collected")]);
  assert.equal(h.factory, undefined);
  assert.equal(h.clock.timeouts.size, 0);
});

test("dispose clears timers and makes captured callbacks inert", () => {
  const h = new WidgetHarness();
  const widget = h.create();
  widget.setJobs([
    job("run", "running"),
    job("done", "completed"),
  ]);
  h.render();
  const interval = [...h.clock.intervals.values()][0]!;
  const timeout = [...h.clock.timeouts.values()][0]!;
  widget.dispose();
  const requests = h.renderRequests;

  assert.equal(h.clock.intervals.size, 0);
  assert.equal(h.clock.timeouts.size, 0);
  assert.equal(h.factory, undefined);
  interval.callback();
  timeout.callback();
  assert.equal(h.renderRequests, requests);
});
