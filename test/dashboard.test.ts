import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSimpleSubagentsExtension } from "../src/index.js";
import { registerSubagentsUi, SubagentsDashboard } from "../src/dashboard.ts";
import type { Job, JobState } from "../src/types.js";

const theme = {
  fg: (color: string, value: string) => `\u001B[${color === "error" ? 31 : 36}m${value}\u001B[0m`,
  bold: (value: string) => `\u001B[1m${value}\u001B[0m`,
} as never;

const plain = (text: string): string => text.replace(/\u001B\[[0-9;]*m/g, "");

const job = (id: string, state: JobState, overrides: Partial<Job> = {}): Job => ({
  id,
  request: { task: `Task for ${id} with enough detail to wrap on a narrow terminal`, agent: "reviewer", writeAccess: id === "job-2" },
  profile: { name: "reviewer", description: "Reviews code", systemPrompt: "Review carefully.", source: "user" },
  state,
  createdAt: 1_000,
  startedAt: state === "running" ? 2_000 : undefined,
  finishedAt: ["completed", "failed", "cancelled"].includes(state) ? 3_000 : undefined,
  progress: [{ type: "tool", text: "Read a long named source file before reporting progress", timestamp: 2_500 }],
  output: `Output for ${id} that must not appear in the dashboard list.`,
  stderr: state === "failed" ? "Failure details that must not appear in the dashboard list." : "",
  usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 },
  malformedEventCount: 0,
  ...overrides,
});

class FakeManager {
  jobs: Job[];
  readonly listeners = new Set<(jobs: readonly Job[]) => void>();
  readonly capturedListeners: Array<(jobs: readonly Job[]) => void> = [];
  readonly calls: string[] = [];
  lifecycleEvents: string[] | undefined;
  listCalls = 0;
  unsubscribeCalls = 0;
  shutdownCalls = 0;
  cancelError: Error | undefined;

  constructor(jobs: Job[] = []) { this.jobs = jobs; }
  currentTime(): number { return 10_000; }
  list(): readonly Job[] { this.listCalls += 1; return structuredClone(this.jobs); }
  subscribe(listener: (jobs: readonly Job[]) => void): () => void {
    this.lifecycleEvents?.push("new manager subscribe");
    this.listeners.add(listener);
    this.capturedListeners.push(listener);
    listener(this.list());
    return () => {
      this.lifecycleEvents?.push("old manager unsubscribe");
      this.unsubscribeCalls += 1;
      this.listeners.delete(listener);
    };
  }
  async cancel(id: string): Promise<Job> {
    this.calls.push(`cancel:${id}`);
    if (this.cancelError) throw this.cancelError;
    return this.change(id, "cancelled");
  }
  shutdown(): Promise<void> { this.shutdownCalls += 1; return Promise.resolve(); }
  setJobs(jobs: Job[]): void { this.jobs = jobs; this.notify(); }
  private change(id: string, state: JobState): Job {
    const entry = this.jobs.find((candidate) => candidate.id === id);
    assert.ok(entry);
    entry.state = state;
    this.notify();
    return structuredClone(entry);
  }
  private notify(): void { for (const listener of this.listeners) listener(this.list()); }
}

class FakeUi {
  readonly theme = theme;
  readonly widgets: Array<unknown> = [];
  readonly notifications: Array<[string, string | undefined]> = [];
  rows = 24;
  component: SubagentsDashboard | undefined;
  lifecycleEvents: string[] | undefined;
  doneCalls = 0;
  renderRequests = 0;
  widgetFactory: ((tui: any, activeTheme: typeof theme) => { render(width: number): string[] }) | undefined;
  setWidget(_key: string, content: unknown): void {
    this.widgets.push(content);
    if (typeof content === "function") this.widgetFactory = content as typeof this.widgetFactory;
    if (content === undefined) {
      this.lifecycleEvents?.push("old live widget clear");
      this.widgetFactory = undefined;
    }
  }
  notify(message: string, level?: "info" | "warning" | "error"): void { this.notifications.push([message, level]); }
  custom(factory: (tui: { requestRender(): void; terminal: { readonly rows: number } }, theme: unknown, keybindings: unknown, done: () => void) => SubagentsDashboard): Promise<void> {
    return new Promise((resolve) => {
      const thisOwner = this;
      this.component = factory({
        requestRender: () => { this.renderRequests += 1; },
        terminal: { get rows() { return thisOwner.rows; } },
      }, theme, {}, () => {
        this.lifecycleEvents?.push("done");
        this.doneCalls += 1;
        resolve();
      });
    });
  }
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  readonly commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  readonly messages: Array<{ message: any; options: any }> = [];
  readonly ui = new FakeUi();
  registerTool(): void {}
  on(event: string, handler: (event: unknown, ctx: any) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }): void { this.commands.set(name, options.handler); }
  sendMessage(message: any, options: any): void { this.messages.push({ message, options }); }
  async emit(event: string, ctx: any): Promise<void> { for (const handler of this.handlers.get(event) ?? []) await handler({}, ctx); }
}

const context = (pi: FakePi, mode: "tui" | "rpc" = "tui") => ({
  mode,
  hasUI: true,
  cwd: "/workspace",
  ui: pi.ui,
  model: undefined,
  thinkingLevel: undefined,
});

const render = (dashboard: SubagentsDashboard, width = 100): string => plain(dashboard.render(width).join("\n"));

const dashboard = (manager: FakeManager, pi = new FakePi(), options: Record<string, unknown> = {}): SubagentsDashboard => new SubagentsDashboard({
  jobs: manager.list(),
  manager: manager as never,
  theme,
  terminalRows: () => pi.ui.rows,
  requestRender: () => { pi.ui.renderRequests += 1; },
  notify: (message: string) => pi.ui.notify(message, "error"),
  close: () => { pi.ui.doneCalls += 1; },
  ...options,
} as never);

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("list mode never exceeds its terminal row and width budget", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 12;
  const states: JobState[] = ["queued", "running", "completed"];
  const view = dashboard(new FakeManager(Array.from({ length: 30 }, (_, index) => job(`job-${index + 1}`, states[index % states.length]!))), pi);
  t.after(() => view.dispose());

  for (const width of [24, 60, 100]) {
    const lines = view.render(width);
    assert.ok(lines.length <= 12, `${lines.length} lines at width ${width}`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
});

test("list mode keeps a selection beyond the row budget in the viewport", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 4;
  const view = dashboard(new FakeManager(Array.from({ length: 30 }, (_, index) => job(`job-${index + 1}`, "running"))), pi);
  t.after(() => view.dispose());

  for (let index = 0; index < 15; index += 1) view.handleInput?.("\x1b[B");

  const lines = view.render(100);
  assert.ok(lines.length <= 4);
  assert.ok(lines.some((line) => plain(line).startsWith("> job-16 ")));
});

test("cancellation but no collection controls affect the selected job", async (t) => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "queued"), job("job-2", "running"), job("job-3", "completed")]);
  const view = dashboard(manager, pi);
  t.after(() => view.dispose());

  view.handleInput?.("x");
  view.handleInput?.("d");
  assert.deepEqual(manager.calls, []);
  assert.deepEqual(pi.messages, []);
  assert.doesNotMatch(render(view), /x collect|d discard/);

  view.handleInput?.("\x1b[B");
  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(manager.calls, ["cancel:job-2"]);
  assert.deepEqual(pi.messages, []);
});

test("compact details use shared status facts and exclude raw captures", (t) => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1", "failed", {
    launchModel: "gpt-5.6-terra",
    model: "gpt-5.6-sol",
    output: "SECRET_OUTPUT_DO_NOT_SHOW",
    stderr: "SECRET_STDERR_DO_NOT_SHOW",
    errorMessage: "SECRET_ERROR_DO_NOT_SHOW",
    outputTruncation: { originalBytes: 1_000, keptBytes: 500 },
    progress: [
      { type: "text", text: "Completed safe status update", timestamp: 2_500 },
      { type: "tool", text: "Started safe tool", timestamp: 2_600 },
      { type: "diagnostic", text: "Safe diagnostic", timestamp: 2_700 },
    ],
  })]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("\r");
  const lines = view.render(120);
  const text = plain(lines.join("\n"));

  for (const line of lines) assert.ok(visibleWidth(line) <= 120, `${visibleWidth(line)} > 120: ${line}`);
  assert.ok(lines.length <= pi.ui.rows);
  for (const label of ["Task:", "Agent:", "Access:", "Launch model:", "Reported model:", "Created:", "Queue:", "Run:", "Usage:", "Recent activity:"]) {
    assert.match(text, new RegExp(label));
  }
  for (const secret of ["SECRET_OUTPUT_DO_NOT_SHOW", "SECRET_STDERR_DO_NOT_SHOW", "SECRET_ERROR_DO_NOT_SHOW"]) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
  assert.match(text, /enter inspect/);
  assert.match(text, /v full/);
});

test("full metadata viewport is bounded by rows and width while showing raw captures only in full view", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 10;
  const legacyJob = job("job-1", "failed", {
    output: "SECRET_OUTPUT_DO_NOT_SHOW",
    stderr: "SECRET_STDERR_DO_NOT_SHOW",
    errorMessage: "SECRET_ERROR_DO_NOT_SHOW",
    malformedEventCount: 1,
    outputTruncation: { originalBytes: 1_000, keptBytes: 500 },
  }) as Job & { malformedEventSamples: string[] };
  legacyJob.malformedEventSamples = ["PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE"];
  const view = dashboard(new FakeManager([legacyJob]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");
  view.handleInput?.("\x1b[F");
  const lines = view.render(120);
  const text = plain(lines.join("\n"));

  assert.ok(lines.length <= pi.ui.rows);
  assert.equal(plain(lines[0] ?? ""), "Subagent job-1 · full view");
  assert.match(plain(lines.at(-1) ?? ""), /^lines \d+–\d+ of \d+ · ↑↓ line · PgUp\/PgDn page · Home\/End · v\/esc back$/);
  assert.match(text, /SECRET_OUTPUT_DO_NOT_SHOW/);
  assert.match(text, /Malformed: 1 malformed protocol/u);
  assert.match(text, /event\./u);
  assert.doesNotMatch(text, /malformed protocol samples|PRIVATE_REASONING_TEXT_MUST_NOT_SURVIVE/ui);
  for (const width of [24, 60, 120]) for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
});

test("full view pages through maximum captured output", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 10;
  const output = Array.from({ length: 1_400 }, (_, index) => `captured output line ${index + 1}`).join("\n");
  const view = dashboard(new FakeManager([job("job-1", "completed", { output })]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");
  const initial = view.render(48);
  assert.ok(initial.length <= pi.ui.rows);
  assert.match(plain(initial.at(-1) ?? ""), /^lines 1–8 of \d+/);

  view.handleInput?.("\x1b[F");
  const final = view.render(48);
  assert.ok(final.length <= pi.ui.rows);
  assert.match(plain(final.join("\n")), /captured output line 1400/);
  for (const line of final) assert.ok(visibleWidth(line) <= 48, `${visibleWidth(line)} > 48: ${line}`);
});

test("full view strips cursor controls from captured sections", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 14;
  const hostile = "before\rafter\t😀 e\u0301 漢\n"
    + "\u001B]0;owned title\u0007"
    + "\u001B[2Jclear\u001B[Hhome\u001B[Kerase"
    + "\u001B[31mred\u001B[0m";
  const view = dashboard(new FakeManager([job("job-1", "failed", {
    output: hostile,
    stderr: hostile,
    errorMessage: hostile,
    malformedEventCount: 1,
    progress: [{ type: "text", text: hostile, timestamp: 2_500 }],
  })]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");
  let text = "";
  for (;;) {
    const lines = view.render(36);
    text += `${plain(lines.join("\n"))}\n`;
    for (const line of lines) assert.ok(visibleWidth(line) <= 36, `${visibleWidth(line)} > 36: ${line}`);
    const viewport = /lines \d+–(\d+) of (\d+)/.exec(plain(lines.at(-1) ?? ""));
    if (viewport?.[1] === viewport?.[2]) break;
    view.handleInput?.("\x1b[6~");
  }

  for (const label of ["Output:", "Stderr:", "Error:", "Malformed:", "Progress:"]) assert.match(text, new RegExp(label));
  assert.doesNotMatch(text, /\r|\t|\u001B\]|\u001B\[2J|\u001B\[H|\u001B\[K/);
  assert.match(text, /😀|漢|é/);
});

test("full view resets its viewport after content shrink", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 10;
  const view = dashboard(new FakeManager([job("job-1", "completed", { output: Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n") })]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");
  view.handleInput?.("\x1b[F");
  pi.ui.rows = 200;
  view.setJobs([job("job-1", "completed", { output: "short" })]);
  const lines = view.render(80);

  assert.match(plain(lines.at(-1) ?? ""), /^lines 1–(\d+) of \1 /);
  assert.match(plain(lines.join("\n")), /short/);
});

test("full title uses the projected job status ID", (t) => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1\twith\runsafe controls", "completed")]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");

  assert.equal(plain(view.render(120)[0] ?? ""), "Subagent job-1 withunsafe controls · full view");
});

test("full metadata wraps each labeled field before truncation", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 200;
  const view = dashboard(new FakeManager([job("job-1", "failed", {
    request: { task: "Task for job-1", agent: "agent-AGENT_VALUE_END", writeAccess: true },
    profile: { name: "agent-AGENT_VALUE_END", description: "Reviews code", systemPrompt: "Review carefully.", source: "user" },
    launchModel: "launch-model-LAUNCH_VALUE_END",
    model: "reported-model-REPORTED_VALUE_END",
    usage: { input: 123456789, output: 987654321, cacheRead: 111111111, cacheWrite: 222222222, cost: 333333333, turns: 444444444 },
    outputTruncation: { originalBytes: 999999999, keptBytes: 111111111 },
  })]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");
  const textWithoutWraps = plain(view.render(12).join("")).replace(/\s+/g, "");

  for (const value of [
    "Agent: agent-AGENT_VALUE_END",
    "Access: write",
    "Launch model: launch-model-LAUNCH_VALUE_END",
    "Reported model: reported-model-REPORTED_VALUE_END",
    "Created: 1970-01-01T00:00:01.000Z",
    "Finished: 1970-01-01T00:00:03.000Z",
    "Usage: input 123456789, output 987654321, cache read 111111111, cache write 222222222, cost 333333333, turns 444444444",
    "Capture: Output capture truncated: retained 111111111 of 999999999 bytes.",
    "Error: reported",
  ]) assert.ok(textWithoutWraps.includes(value.replace(/\s+/g, "")), `missing wrapped metadata: ${value}`);
});

test("full navigation returns to its prior view without closing the dashboard", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 10;
  const view = dashboard(new FakeManager([job("job-1", "completed")]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("v");
  const firstFooter = plain(view.render(120).at(-1) ?? "");
  view.handleInput?.("\x1b[6~");
  assert.notEqual(plain(view.render(120).at(-1) ?? ""), firstFooter);
  view.handleInput?.("\x1b[F");
  const lastFooter = plain(view.render(120).at(-1) ?? "");
  assert.notEqual(lastFooter, firstFooter);
  view.handleInput?.("\x1b[H");
  assert.equal(plain(view.render(120).at(-1) ?? ""), firstFooter);
  view.handleInput?.("\x1b");
  assert.match(render(view), /> job-1 completed/);

  view.handleInput?.("\r");
  view.handleInput?.("v");
  view.handleInput?.("v");
  assert.match(render(view), /Task: Task for job-1/);
  assert.equal(pi.ui.doneCalls, 0);
});

test("full reconciliation returns to list with the nearest selection and reset viewport", (t) => {
  const pi = new FakePi();
  pi.ui.rows = 10;
  const view = dashboard(new FakeManager([job("job-1", "completed"), job("job-2", "completed"), job("job-3", "completed")]), pi);
  t.after(() => view.dispose());

  view.handleInput?.("\x1b[B");
  view.handleInput?.("v");
  view.handleInput?.("\x1b[F");
  view.setJobs([job("job-1", "completed"), job("job-3", "completed")]);

  const state = view as unknown as { mode: string; fullOffset: number };
  assert.equal(state.mode, "list");
  assert.equal(state.fullOffset, 0);
  assert.match(render(view), /> job-3 completed/);
});

test("preserves selected identity across snapshots and selects the nearest visible job", (t) => {
  const manager = new FakeManager([job("job-1", "running"), job("job-2", "running"), job("job-3", "running")]);
  const view = dashboard(manager);
  t.after(() => view.dispose());

  view.handleInput?.("\x1b[B");
  view.setJobs([job("job-3", "running"), job("job-2", "running"), job("job-1", "running")]);
  assert.match(render(view), /> job-2 /);

  view.handleInput?.("\r");
  view.setJobs([job("job-3", "running"), job("job-1", "running")]);
  assert.match(render(view), /Task: Task for job-1/);
});

test("constructing a running dashboard creates no refresh interval", (t) => {
  const originalSetInterval = globalThis.setInterval;
  let intervalCalls = 0;
  globalThis.setInterval = ((..._args: Parameters<typeof setInterval>) => {
    intervalCalls += 1;
    return 0 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  t.after(() => { globalThis.setInterval = originalSetInterval; });

  const view = dashboard(new FakeManager([job("job-1", "running")]));
  t.after(() => view.dispose());

  assert.equal(intervalCalls, 0);
});

test("assistant deltas retain the latest snapshot without token-rate renders", (t) => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1", "running", {
    progress: [{ type: "text", text: "a", timestamp: 2_500 }],
  })]), pi);
  t.after(() => view.dispose());

  const requests = pi.ui.renderRequests;
  view.setJobs([job("job-1", "running", {
    progress: [{ type: "text", text: "ab", timestamp: 2_600 }],
  })]);
  view.setJobs([job("job-1", "running", {
    progress: [{ type: "text", text: "abc latest", timestamp: 2_700 }],
  })]);

  assert.equal(pi.ui.renderRequests, requests);
  view.handleInput?.("\r");
  assert.match(render(view), /abc latest/);
});

test("post-limit assistant deltas do not redraw when only original bytes grow", (t) => {
  const pi = new FakePi();
  const cappedText = "x".repeat(50 * 1024);
  const view = dashboard(new FakeManager([job("job-1", "running", {
    progress: [{ type: "text", text: cappedText, timestamp: 2_500, truncation: { originalBytes: 50 * 1024 + 1, keptBytes: 50 * 1024 } }],
  })]), pi);
  t.after(() => view.dispose());

  const requests = pi.ui.renderRequests;
  view.setJobs([job("job-1", "running", {
    progress: [{ type: "text", text: cappedText, timestamp: 2_600, truncation: { originalBytes: 50 * 1024 + 2, keptBytes: 50 * 1024 } }],
  })]);
  view.setJobs([job("job-1", "running", {
    progress: [{ type: "text", text: cappedText, timestamp: 2_700, truncation: { originalBytes: 50 * 1024 + 3, keptBytes: 50 * 1024 } }],
  })]);

  assert.equal(pi.ui.renderRequests, requests);
});

test("terminal queued cancellation shows its queue duration in the dashboard", (t) => {
  const view = dashboard(new FakeManager([job("job-1", "cancelled", { startedAt: undefined })]));
  t.after(() => view.dispose());

  assert.match(render(view), /> job-1 cancelled 2s/);
});

test("tool phases, usage, and completed state each request one render", (t) => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1", "running", {
    progress: [{ type: "text", text: "a", timestamp: 2_500 }],
  })]), pi);
  t.after(() => view.dispose());

  let requests = pi.ui.renderRequests;
  view.setJobs([job("job-1", "running", {
    progress: [
      { type: "text", text: "a", timestamp: 2_500 },
      { type: "tool", text: "Read dashboard.ts", timestamp: 2_600 },
    ],
  })]);
  assert.equal(pi.ui.renderRequests, requests + 1);

  requests = pi.ui.renderRequests;
  view.setJobs([job("job-1", "running", {
    progress: [
      { type: "text", text: "a", timestamp: 2_500 },
      { type: "tool", text: "Read dashboard.ts", timestamp: 2_600 },
    ],
    usage: { input: 2, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 },
  })]);
  assert.equal(pi.ui.renderRequests, requests + 1);

  requests = pi.ui.renderRequests;
  view.setJobs([job("job-1", "completed", {
    progress: [
      { type: "text", text: "a", timestamp: 2_500 },
      { type: "tool", text: "Read dashboard.ts", timestamp: 2_600 },
    ],
    usage: { input: 2, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 },
  })]);
  assert.equal(pi.ui.renderRequests, requests + 1);
});

test("dashboard ignores snapshots, input, and invalidation after disposal", () => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1", "running")]), pi);
  const initial = render(view);
  view.dispose();
  view.setJobs([job("job-1", "completed")]);
  view.handleInput?.("\r");
  view.invalidate();

  assert.equal(pi.ui.renderRequests, 0);
  assert.equal(render(view), initial);
});

test("dashboard reports a failed cancellation and closes on escape", async (t) => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  manager.cancelError = new Error("cancel failed");
  const view = dashboard(manager, pi);
  t.after(() => view.dispose());

  const listCallsBeforeCancellation = manager.listCalls;
  manager.setJobs([job("job-1", "completed")]);
  view.handleInput?.("c");
  await nextTurn();
  assert.equal(manager.listCalls, listCallsBeforeCancellation + 1);
  assert.match(render(view), /> job-1 completed/);
  assert.deepEqual(pi.ui.notifications, [["Could not cancel subagent job.", "error"]]);

  view.handleInput?.("\x1b");
  assert.equal(pi.ui.doneCalls, 1);
});

test("registration installs one live widget and clears it after work disappears", async () => {
  const manager = new FakeManager([]);
  const pi = new FakePi();
  const cleanup = registerSubagentsUi(pi as never, manager as never);
  await pi.emit("session_start", context(pi));
  manager.setJobs([job("job-1", "running")]);

  assert.equal(pi.ui.widgets.filter((entry) => typeof entry === "function").length, 1);
  const widgets = pi.ui.widgets as unknown[] & { findLast(predicate: (entry: unknown) => boolean): unknown };
  const factory = widgets.findLast((entry: unknown) => typeof entry === "function") as any;
  const component = factory({ requestRender: () => { pi.ui.renderRequests += 1; }, terminal: { columns: 100 } }, theme);
  assert.match(plain(component.render(100).join("\n")), /Subagents[\s\S]*job-1/u);

  manager.setJobs([job("job-1", "collected")]);
  assert.equal(pi.ui.widgets.at(-1), undefined);
  cleanup();
});

test("captured manager callback cannot render after Escape closes the dashboard", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  registerSubagentsUi(pi as never, manager as never);
  const command = pi.commands.get("subagents");
  assert.ok(command);

  const opening = command("", context(pi));
  const view = pi.ui.component;
  const captured = manager.capturedListeners.at(-1);
  assert.ok(view);
  assert.ok(captured);
  view.handleInput?.("\x1b");
  await opening;
  const renderRequests = pi.ui.renderRequests;

  captured([job("job-1", "completed")]);

  assert.equal(pi.ui.renderRequests, renderRequests);
});

test("registration cleanup closes the active dashboard and clears resources once", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  const cleanup = registerSubagentsUi(pi as never, manager as never);
  await pi.emit("session_start", context(pi));
  const command = pi.commands.get("subagents");
  assert.ok(command);

  const opening = command("", context(pi));
  assert.ok(pi.ui.component);
  const capturedListeners = [...manager.capturedListeners];
  cleanup();
  cleanup();

  assert.equal(pi.ui.doneCalls, 1);
  await opening;
  assert.equal(manager.unsubscribeCalls, 2);
  assert.equal(manager.listeners.size, 0);
  assert.equal(pi.ui.widgets.at(-1), undefined);
  const renderRequests = pi.ui.renderRequests;
  manager.setJobs([job("job-1", "completed")]);
  for (const captured of capturedListeners) captured([job("job-1", "completed")]);
  assert.equal(pi.ui.renderRequests, renderRequests);
  assert.equal(pi.ui.widgets.at(-1), undefined);
  assert.equal(manager.unsubscribeCalls, 2);
});

test("replacement session clears the old live widget before subscribing the new session", async (t) => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  const lifecycleEvents: string[] = [];
  pi.ui.lifecycleEvents = lifecycleEvents;
  manager.lifecycleEvents = lifecycleEvents;
  const cleanup = registerSubagentsUi(pi as never, manager as never);
  t.after(cleanup);
  await pi.emit("session_start", context(pi));
  lifecycleEvents.length = 0;

  await pi.emit("session_start", context(pi));

  assert.deepEqual(lifecycleEvents, ["old manager unsubscribe", "old live widget clear", "new manager subscribe"]);
  assert.equal(manager.listeners.size, 1);
});

test("subagents command rejects non-TUI mode and reads the live terminal row count", async () => {
  const pi = new FakePi();
  const manager = new FakeManager(Array.from({ length: 30 }, (_, index) => job(`job-${index + 1}`, "running")));
  registerSubagentsUi(pi as never, manager as never);
  const command = pi.commands.get("subagents");
  assert.ok(command);

  await command("", context(pi, "rpc"));
  assert.deepEqual(pi.ui.notifications, [["The subagents dashboard requires interactive mode.", "warning"]]);

  pi.ui.rows = 12;
  const opening = command("", context(pi));
  const view = pi.ui.component;
  assert.ok(view);
  assert.ok(view.render(80).length <= 12);
  view.handleInput?.("\x1b");
  await opening;
  assert.equal(manager.unsubscribeCalls, 1);
  assert.equal(pi.ui.doneCalls, 1);
});

test("extension clears the widget before manager shutdown", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  const events: string[] = [];
  const setWidget = pi.ui.setWidget.bind(pi.ui);
  pi.ui.setWidget = (_key, content) => { if (content === undefined) events.push("clear"); setWidget(_key, content); };
  manager.shutdown = async () => { events.push("shutdown"); manager.shutdownCalls += 1; };
  createSimpleSubagentsExtension({
    createManager: () => manager as never,
    loadConfig: async () => ({ config: { confirmWrites: false } }),
    discoverProfiles: async () => ({ agents: [], diagnostics: [] }),
  })(pi as never);

  await pi.emit("session_start", context(pi));
  await pi.emit("session_shutdown", context(pi));
  await pi.emit("session_shutdown", context(pi));

  assert.deepEqual(events, ["clear", "shutdown"]);
  assert.equal(manager.shutdownCalls, 1);
});
