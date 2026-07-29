import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
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
  cancelError: Error | undefined;

  constructor(jobs: Job[] = []) { this.jobs = jobs; }
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
  collect(id: string): Job {
    this.calls.push(`collect:${id}`);
    return this.transitionInbox(id, "collected", "collect");
  }
  discard(id: string): Job {
    this.calls.push(`discard:${id}`);
    return this.transitionInbox(id, "discarded", "discard");
  }
  shutdown(): Promise<void> { this.shutdownCalls += 1; return Promise.resolve(); }
  setJobs(jobs: Job[]): void { this.jobs = jobs; this.notify(); }
  private transitionInbox(id: string, state: JobState, action: string): Job {
    const entry = this.jobs.find((candidate) => candidate.id === id);
    assert.ok(entry);
    if (!["completed", "failed", "cancelled"].includes(entry.state)) throw new Error(`Cannot ${action} job in ${entry.state} state`);
    return this.change(id, state);
  }
  private change(id: string, state: JobState): Job {
    const entry = this.jobs.find((candidate) => candidate.id === id);
    assert.ok(entry);
    entry.state = state;
    this.notify();
    return structuredClone(entry);
  }
  private notify(): void { for (const listener of this.listeners) listener(this.list()); }
}

class ManualTimer {
  readonly callbacks = new Map<number, () => void>();
  readonly cleared: number[] = [];
  private next = 1;

  set = (callback: () => void): number => {
    const handle = this.next++;
    this.callbacks.set(handle, callback);
    return handle;
  };

  clear = (handle: number): void => {
    this.cleared.push(handle);
    this.callbacks.delete(handle);
  };

  tick(): void { for (const callback of this.callbacks.values()) callback(); }
}

class FakeUi {
  readonly theme = theme;
  readonly widgets: Array<unknown> = [];
  readonly notifications: Array<[string, string | undefined]> = [];
  component: SubagentsDashboard | undefined;
  doneCalls = 0;
  renderRequests = 0;
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

const render = (dashboard: SubagentsDashboard, width = 100): string => plain(dashboard.render(width).join("\n"));

const dashboard = (manager: FakeManager, pi = new FakePi(), options: Record<string, unknown> = {}): SubagentsDashboard => new SubagentsDashboard({
  jobs: manager.list(),
  manager: manager as never,
  pi: pi as never,
  theme,
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

test("dashboard preserves ANSI-aware width bounds for compact and detailed output", () => {
  const view = dashboard(new FakeManager([job("job-1", "queued"), job("job-2", "running"), job("job-3", "failed")]));

  for (const width of [30, 60, 100]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
  view.handleInput?.("\r");
  for (const width of [30, 60, 100]) {
    const lines = view.render(width);
    assert.match(plain(lines.join("\n")), /Task:/);
    assert.match(plain(lines.join("\n")), /Usage:/);
    assert.ok(lines.some((line) => line.includes("\u001B[")), "theme output should include ANSI escapes");
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
  view.dispose();
});

test("dashboard uses its grouped displayed order for navigation and destructive actions", async () => {
  const manager = new FakeManager([job("running", "running"), job("queued", "queued"), job("ready", "completed")]);
  const view = dashboard(manager);

  assert.match(render(view), /> queued queued/);
  view.handleInput?.("\x1b[B");
  assert.match(render(view), /> running running/);
  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(manager.calls, ["cancel:running"]);
  view.dispose();
});

test("dashboard retains selected identity after reordering and falls back to the nearest grouped row after removal", async () => {
  const manager = new FakeManager([job("running", "running"), job("queued", "queued"), job("ready", "completed")]);
  const view = dashboard(manager);

  view.handleInput?.("\x1b[B");
  manager.setJobs([job("ready", "completed"), job("queued", "queued"), job("running", "running")]);
  view.setJobs(manager.list());
  assert.match(render(view), /> running running/);

  manager.setJobs([job("queued", "queued"), job("replacement", "running"), job("ready", "completed")]);
  view.setJobs(manager.list());
  assert.match(render(view), /> replacement running/);
  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(manager.calls, ["cancel:replacement"]);
  view.dispose();
});

test("dashboard keeps navigation in range, renders exact help and write marker, toggles details, and closes on escape", () => {
  const pi = new FakePi();
  const view = dashboard(new FakeManager([job("job-1", "queued"), job("job-2", "running")]), pi);

  view.handleInput?.("\x1b[A");
  assert.match(render(view), /> job-1/);
  view.handleInput?.("\x1b[B");
  view.handleInput?.("\x1b[B");
  assert.match(render(view), /> job-2 W running/);
  assert.match(render(view), /↑↓ navigate · enter inspect · c cancel · x collect · d discard · esc close/);
  view.handleInput?.("\r");
  assert.match(render(view), /DETAIL/);
  view.handleInput?.("\r");
  assert.doesNotMatch(render(view), /DETAIL/);
  view.handleInput?.("\x1b");
  assert.equal(pi.ui.doneCalls, 1);
});

test("dashboard details always render every required label with absent-value placeholders", () => {
  const view = dashboard(new FakeManager([job("job-1", "queued", {
    progress: [], output: "", stderr: "", startedAt: undefined, finishedAt: undefined, truncation: undefined,
  })]));

  view.handleInput?.("\r");
  const detail = render(view, 160);
  for (const label of ["Task:", "Profile:", "Access:", "Created:", "Started:", "Finished:", "Progress:", "Output:", "Stderr:", "Usage:", "Truncated:"]) {
    assert.ok(detail.includes(label), `missing ${label}`);
  }
  assert.match(detail, /Started: not started/);
  assert.match(detail, /Finished: not finished/);
  assert.match(detail, /Progress: none/);
  assert.match(detail, /Output: none/);
  assert.match(detail, /Stderr: none/);
  assert.match(detail, /Truncated: not truncated/);
});

test("dashboard refresh tick invalidates elapsed rendering and is cleared when no running job remains or it closes", () => {
  const pi = new FakePi();
  const timer = new ManualTimer();
  let now = 2_000;
  const view = dashboard(new FakeManager([job("job-1", "running")]), pi, {
    now: () => now,
    setInterval: timer.set,
    clearInterval: timer.clear,
  });

  assert.match(render(view), /0s/);
  now = 7_000;
  timer.tick();
  assert.ok(pi.ui.renderRequests > 0);
  assert.match(render(view), /5s/);
  view.setJobs([job("job-1", "completed")]);
  assert.equal(timer.callbacks.size, 0);
  assert.equal(timer.cleared.length, 1);

  const closingTimer = new ManualTimer();
  const closingView = dashboard(new FakeManager([job("job-2", "running")]), pi, {
    setInterval: closingTimer.set,
    clearInterval: closingTimer.clear,
  });
  closingView.handleInput?.("\x1b");
  assert.equal(closingTimer.callbacks.size, 0);
  assert.equal(closingTimer.cleared.length, 1);
});

test("dashboard contains rejected cancellation and refreshes stale collect and discard races without sending failed results", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "running")]);
  manager.cancelError = new Error("cancel failed");
  const view = dashboard(manager, pi);

  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(manager.calls, ["cancel:job-1"]);
  assert.deepEqual(pi.ui.notifications, [["Could not cancel subagent job.", "error"]]);

  manager.cancelError = undefined;
  manager.setJobs([job("job-2", "completed")]);
  const collectView = dashboard(manager, pi);
  manager.jobs[0]!.state = "running";
  collectView.handleInput?.("x");
  assert.equal(pi.messages.length, 0);
  assert.match(render(collectView), /RUNNING/);

  manager.setJobs([job("job-3", "completed")]);
  const discardView = dashboard(manager, pi);
  manager.jobs[0]!.state = "running";
  discardView.handleInput?.("d");
  assert.match(render(discardView), /RUNNING/);
  assert.deepEqual(pi.ui.notifications.slice(-2), [
    ["Could not collect subagent job.", "error"],
    ["Could not discard subagent job.", "error"],
  ]);
  view.dispose();
  collectView.dispose();
  discardView.dispose();
});

test("dashboard ignores a rejected cancellation after it is closed", async () => {
  const pi = new FakePi();
  const timer = new ManualTimer();
  const manager = new FakeManager([job("job-1", "running")]);
  let rejectCancel: (reason?: unknown) => void = () => {};
  manager.cancel = (id: string): Promise<Job> => {
    manager.calls.push(`cancel:${id}`);
    return new Promise((_resolve, reject) => { rejectCancel = reject; });
  };
  const view = dashboard(manager, pi, {
    setInterval: timer.set,
    clearInterval: timer.clear,
  });

  view.handleInput?.("c");
  view.handleInput?.("\x1b");
  const renderRequestsAtClose = pi.ui.renderRequests;
  const notificationsAtClose = pi.ui.notifications.length;
  assert.equal(timer.callbacks.size, 0);
  assert.equal(timer.cleared.length, 1);

  rejectCancel(new Error("cancel failed"));
  await nextTurn();

  assert.equal(timer.callbacks.size, 0);
  assert.equal(timer.cleared.length, 1);
  assert.equal(pi.ui.renderRequests, renderRequestsAtClose);
  assert.equal(pi.ui.notifications.length, notificationsAtClose);
});

test("dashboard restricts cancel, collect, and discard to eligible selected states", async () => {
  const pi = new FakePi();
  const manager = new FakeManager([job("job-1", "queued"), job("job-2", "running"), job("job-3", "completed")]);
  const view = dashboard(manager, pi);

  view.handleInput?.("x");
  view.handleInput?.("d");
  assert.deepEqual(manager.calls, []);
  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(manager.calls, ["cancel:job-1"]);
  view.setJobs(manager.list());
  view.handleInput?.("\x1b[A");
  view.handleInput?.("c");
  await nextTurn();
  assert.deepEqual(manager.calls, ["cancel:job-1", "cancel:job-2"]);
  view.setJobs(manager.list());
  view.handleInput?.("\x1b[B");
  view.handleInput?.("d");
  assert.deepEqual(manager.calls, ["cancel:job-1", "cancel:job-2", "discard:job-3"]);
  view.dispose();
});

test("dashboard collection formats completed, failed, and cancelled terminal snapshots before delivery", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const pi = new FakePi();
    const manager = new FakeManager([job("job-1", state, { output: "The collected answer", stderr: "The terminal error" })]);
    const view = dashboard(manager, pi);

    view.handleInput?.("x");

    assert.deepEqual(manager.calls, ["collect:job-1"]);
    assert.equal(manager.jobs[0]?.state, "collected");
    assert.equal(pi.messages.length, 1);
    assert.equal(pi.messages[0]?.message.customType, "simple-subagents-result");
    assert.equal(pi.messages[0]?.message.display, true);
    assert.ok(pi.messages[0]?.message.content.includes(`Status: ${state}`));
    assert.match(pi.messages[0]?.message.content, /The collected answer/);
    if (state !== "completed") assert.match(pi.messages[0]?.message.content, /The terminal error/);
    assert.deepEqual(pi.messages[0]?.options, { deliverAs: "nextTurn" });
  }
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

test("subagents command rejects non-TUI mode and invalidates an established render cache on live updates", async () => {
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
  assert.match(render(view), /RUNNING/);
  const before = pi.ui.renderRequests;
  manager.setJobs([job("job-1", "completed")]);
  assert.ok(pi.ui.renderRequests > before);
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
