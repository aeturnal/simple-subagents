import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { createSimpleSubagentsExtension } from "../src/index.js";
import { formatWidgetLines, registerSubagentsUi, SubagentsDashboard } from "../src/dashboard.ts";
import type { Job, JobState } from "../src/types.js";

const theme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as never;

const job = (id: string, state: JobState, overrides: Partial<Job> = {}): Job => ({
  id,
  request: { task: `Task for ${id} with enough detail to wrap on a narrow terminal`, agent: "reviewer", writeAccess: id === "job-2" },
  profile: { name: "reviewer", description: "Reviews code", systemPrompt: "Review carefully.", source: "user" },
  state,
  createdAt: 1_000,
  startedAt: state === "running" ? 2_000 : undefined,
  finishedAt: ["completed", "failed", "cancelled"].includes(state) ? 3_000 : undefined,
  progress: [{ type: "tool", text: "Read a long named source file before reporting progress", timestamp: 2_500 }],
  output: `Output for ${id} that should be wrapped rather than overflow a narrow terminal.`,
  stderr: state === "failed" ? "Failure details that should also be wrapped." : "",
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

  constructor(jobs: Job[] = []) { this.jobs = jobs; }
  list(): readonly Job[] { return structuredClone(this.jobs); }
  subscribe(listener: (jobs: readonly Job[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => { this.unsubscribeCalls += 1; this.listeners.delete(listener); };
  }
  async cancel(id: string): Promise<Job> { this.calls.push(`cancel:${id}`); return this.change(id, "cancelled"); }
  collect(id: string): Job { this.calls.push(`collect:${id}`); return this.change(id, "collected"); }
  discard(id: string): Job { this.calls.push(`discard:${id}`); return this.change(id, "discarded"); }
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
  component: SubagentsDashboard | undefined;
  doneCalls = 0;
  private resolveCustom: (() => void) | undefined;

  setWidget(_key: string, content: unknown): void { this.widgets.push(content); }
  notify(message: string, level?: "info" | "warning" | "error"): void { this.notifications.push([message, level]); }
  custom(factory: (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: () => void) => SubagentsDashboard): Promise<void> {
    return new Promise((resolve) => {
      this.resolveCustom = resolve;
      this.component = factory({ requestRender: () => { this.renderRequests += 1; } }, theme, {}, () => {
        this.doneCalls += 1;
        resolve();
      });
    });
  }
  renderRequests = 0;
  close(): void { this.resolveCustom?.(); }
}

class FakePi {
  readonly handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  readonly commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
  readonly renderers = new Map<string, (message: any, options: any, theme: any) => { render(width: number): string[] }>();
  readonly messages: Array<{ message: any; options: any }> = [];
  readonly ui = new FakeUi();
  registerTool(): void {}
  on(event: string, handler: (event: unknown, ctx: any) => unknown): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }): void { this.commands.set(name, options.handler); }
  registerMessageRenderer(name: string, renderer: (message: any, options: any, theme: any) => { render(width: number): string[] }): void { this.renderers.set(name, renderer); }
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

const render = (dashboard: SubagentsDashboard, width = 100): string => dashboard.render(width).join("\n");

const dashboard = (manager: FakeManager, pi = new FakePi()): SubagentsDashboard => new SubagentsDashboard({
  jobs: manager.list(),
  manager: manager as never,
  pi: pi as never,
  theme,
  requestRender: () => { pi.ui.renderRequests += 1; },
  close: () => { pi.ui.doneCalls += 1; },
});

test("formats compact widget attention counts while excluding collected and discarded jobs", () => {
  const lines = formatWidgetLines([
    job("job-1", "queued"), job("job-2", "running"), job("job-3", "completed"),
    job("job-4", "failed"), job("job-5", "cancelled"), job("job-6", "collected"), job("job-7", "discarded"),
  ], theme);

  assert.deepEqual(lines, ["● Subagents · 1 queued · 1 running · 3 ready"]);
  assert.deepEqual(formatWidgetLines([job("job-8", "collected"), job("job-9", "discarded")], theme), []);
});

test("dashboard keeps every compact and detailed render line within its available width", () => {
  const view = dashboard(new FakeManager([job("job-1", "queued"), job("job-2", "running"), job("job-3", "failed")]));

  for (const width of [30, 60, 100]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
  view.handleInput?.("\r");
  for (const width of [30, 60, 100]) {
    const lines = view.render(width);
    assert.match(lines.join("\n"), /Task:/);
    assert.match(lines.join("\n"), /Usage:/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
});

test("dashboard navigation stays in bounds, toggles details, and closes on escape", () => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1", "queued"), job("job-2", "running")]), pi);

  view.handleInput?.("\x1b[A");
  assert.match(render(view), /> job-1/);
  view.handleInput?.("\x1b[B");
  view.handleInput?.("\x1b[B");
  assert.match(render(view), /> job-2/);
  view.handleInput?.("\r");
  assert.match(render(view), /DETAIL/);
  view.handleInput?.("\r");
  assert.doesNotMatch(render(view), /DETAIL/);
  view.handleInput?.("\x1b");
  assert.equal(pi.ui.doneCalls, 1);
});

test("dashboard restricts cancel, collect, and discard to eligible selected states", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "queued"), job("job-2", "running"), job("job-3", "completed")]);
  const view = dashboard(manager, pi);

  view.handleInput?.("x");
  view.handleInput?.("d");
  assert.deepEqual(manager.calls, []);
  view.handleInput?.("c");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.calls, ["cancel:job-1"]);
  view.setJobs(manager.list());
  view.handleInput?.("\x1b[B");
  view.handleInput?.("c");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(manager.calls, ["cancel:job-1", "cancel:job-2"]);
  view.setJobs(manager.list());
  view.handleInput?.("\x1b[B");
  view.handleInput?.("d");
  assert.deepEqual(manager.calls, ["cancel:job-1", "cancel:job-2", "discard:job-3"]);
});

test("dashboard collection formats the pre-collection snapshot and injects only that result for the next turn", () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "completed", { output: "The collected answer" })]);
  const view = dashboard(manager, pi);

  view.handleInput?.("x");

  assert.deepEqual(manager.calls, ["collect:job-1"]);
  assert.equal(manager.jobs[0]?.state, "collected");
  assert.equal(pi.messages.length, 1);
  assert.equal(pi.messages[0]?.message.customType, "simple-subagents-result");
  assert.equal(pi.messages[0]?.message.display, true);
  assert.match(pi.messages[0]?.message.content, /Status: completed/);
  assert.match(pi.messages[0]?.message.content, /The collected answer/);
  assert.deepEqual(pi.messages[0]?.options, { deliverAs: "nextTurn" });
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

test("subagents command rejects non-TUI mode and live dashboard subscriptions invalidate, render, and unsubscribe once on close", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  registerSubagentsUi(pi as never, manager as never);
  const command = pi.commands.get("subagents");
  assert.ok(command);

  await command("", context(pi, "rpc"));
  assert.deepEqual(pi.ui.notifications, [["The subagents dashboard requires interactive mode.", "warning"]]);

  const opening = command("", context(pi));
  const view = pi.ui.component;
  assert.ok(view);
  manager.setJobs([job("job-1", "completed")]);
  assert.ok(pi.ui.renderRequests > 0);
  assert.match(render(view), /INBOX/);
  view.handleInput?.("\x1b");
  await opening;
  assert.equal(manager.unsubscribeCalls, 1);
  assert.equal(pi.ui.doneCalls, 1);
});

test("registration supplies a Markdown renderer for displayed collected results", () => {
  initTheme();
  const pi = new FakePi();
  registerSubagentsUi(pi as never, new FakeManager() as never);
  const renderer = pi.renderers.get("simple-subagents-result");
  assert.ok(renderer);
  assert.match(renderer({ content: "# Result\n\n**complete**" }, { outputPad: 0 }, theme).render(80).join("\n"), /Result/);
});

test("extension clears the widget before manager shutdown while retaining notifier cleanup", async () => {
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
