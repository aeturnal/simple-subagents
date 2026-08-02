import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSimpleSubagentsExtension } from "../src/index.js";
import { formatWidgetLines, registerSubagentsUi, SubagentsDashboard } from "../src/dashboard.ts";
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
  readonly calls: string[] = [];
  unsubscribeCalls = 0;
  shutdownCalls = 0;
  cancelError: Error | undefined;

  constructor(jobs: Job[] = []) { this.jobs = jobs; }
  currentTime(): number { return 10_000; }
  list(): readonly Job[] { return structuredClone(this.jobs); }
  subscribe(listener: (jobs: readonly Job[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.unsubscribeCalls += 1; this.listeners.delete(listener); };
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
  doneCalls = 0;
  renderRequests = 0;
  setWidget(_key: string, content: unknown): void { this.widgets.push(content); }
  notify(message: string, level?: "info" | "warning" | "error"): void { this.notifications.push([message, level]); }
  custom(factory: (tui: { requestRender(): void; terminal: { readonly rows: number } }, theme: unknown, keybindings: unknown, done: () => void) => SubagentsDashboard): Promise<void> {
    return new Promise((resolve) => {
      const thisOwner = this;
      this.component = factory({
        requestRender: () => { this.renderRequests += 1; },
        terminal: { get rows() { return thisOwner.rows; } },
      }, theme, {}, () => {
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

test("formats compact widget attention counts while excluding collected and discarded jobs", () => {
  const lines = formatWidgetLines([
    job("job-1", "queued"), job("job-2", "running"), job("job-3", "completed"),
    job("job-4", "failed"), job("job-5", "cancelled"), job("job-6", "collected"), job("job-7", "discarded"),
  ], theme);

  assert.equal(plain(lines[0] ?? ""), "● Subagents · 1 queued · 1 running · 3 ready");
  assert.deepEqual(formatWidgetLines([job("job-8", "collected"), job("job-9", "discarded")], theme), []);
});

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

test("list navigation preserves the selected identity across a manager update", (t) => {
  const manager = new FakeManager([job("running", "running"), job("queued", "queued"), job("ready", "completed")]);
  const view = dashboard(manager);
  t.after(() => view.dispose());

  view.handleInput?.("\x1b[B");
  manager.setJobs([job("ready", "completed"), job("queued", "queued"), job("running", "running")]);
  view.setJobs(manager.list());

  assert.match(render(view), /> running/);
});

test("dashboard reports a failed cancellation and closes on escape", async (t) => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  manager.cancelError = new Error("cancel failed");
  const view = dashboard(manager, pi);
  t.after(() => view.dispose());

  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(pi.ui.notifications, [["Could not cancel subagent job.", "error"]]);

  view.handleInput?.("\x1b");
  assert.equal(pi.ui.doneCalls, 1);
});

test("registration updates and clears the compact widget from live manager changes", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  const cleanup = registerSubagentsUi(pi as never, manager as never);
  await pi.emit("session_start", context(pi));

  const factory = pi.ui.widgets.at(-1) as ((tui: unknown, activeTheme: typeof theme) => { render(width: number): string[] }) | undefined;
  assert.ok(factory);
  for (const width of [30, 60, 100]) for (const line of factory({}, theme).render(width)) assert.ok(visibleWidth(line) <= width);
  manager.setJobs([job("job-1", "collected")]);
  assert.equal(pi.ui.widgets.at(-1), undefined);
  cleanup();
  assert.equal(manager.unsubscribeCalls, 1);
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

  assert.deepEqual(events, ["clear", "shutdown"]);
  assert.equal(manager.shutdownCalls, 1);
});
