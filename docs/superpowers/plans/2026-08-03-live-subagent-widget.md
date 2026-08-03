# Live Subagent Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the automatic one-line subagent count with a width-safe animated tree that shows live activity and lingers terminal jobs for three seconds, without changing `/subagents`.

**Architecture:** Add `src/live-widget.ts` as a focused presentation and redraw module. Its pure formatter maps immutable job snapshots to tree lines, while its controller installs one above-editor widget and owns one animation interval plus one nearest-deadline timeout. `registerSubagentsUi` remains the session lifecycle owner and feeds manager snapshots into the controller.

**Tech Stack:** TypeScript 5.9, Node.js 22, `node:test`, `tsx`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`

## Global Constraints

- Keep the existing `/subagents` dashboard layout, controls, progress fingerprint, and timer-free full-screen rendering unchanged.
- Display running jobs first, queued jobs second, and terminal jobs still inside their three-second linger window last; preserve manager order inside each group.
- Never display collected or discarded jobs.
- Count tokens as `usage.input + usage.output` and tool uses as `tool` progress entries beginning with `Started `.
- Use only existing bounded job and status data; add no conversation capture or child protocol fields.
- Run an 80 ms Braille animation interval only while at least one job is running.
- At exactly `finishedAt + 3000ms`, a terminal job is no longer visible.
- Install the widget once while visible; use `tui.requestRender()` for later redraws instead of replacing it.
- Every emitted line must have visible width less than or equal to the supplied terminal width.
- Add no dependency and do not alter lifecycle, collection, discard, process, concurrency, or result behavior.
- Follow strict red-green-refactor TDD: each production behavior needs a test that was observed failing first.

---

### Task 1: Build the pure live-tree formatter through TDD

**Files:**

- Create: `src/live-widget.ts`
- Create: `test/live-widget.test.ts`

**Interfaces:**

- Produces: `LiveWidgetTheme`
- Produces: `LiveWidgetRenderOptions`
- Produces: `formatLiveWidgetLines(jobs: readonly Job[], options: LiveWidgetRenderOptions): string[]`
- Consumes: `projectJobStatus(job, now)` from `src/job-status.ts`
- Consumes: `Job` from `src/types.ts`

- [ ] **Step 1: Write failing tests for state selection, ordering, icons, tree structure, and activity**

Create `test/live-widget.test.ts` with a fixed theme and job builder. The formatter import is intentionally missing at this point:

```ts
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
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: FAIL with module-not-found for `src/live-widget.ts`. This proves the new behavior is absent rather than accidentally covered by the old one-line formatter.

- [ ] **Step 3: Add the minimum formatter, selection, icons, and activity implementation**

Create `src/live-widget.ts` with these imports, interfaces, constants, and pure helpers:

```ts
import { truncateToWidth } from "@earendil-works/pi-tui";
import { projectJobStatus } from "./job-status.js";
import type { Job } from "./types.js";

export interface LiveWidgetTheme {
  fg(color: "accent" | "dim" | "error" | "muted" | "success", text: string): string;
  bold(text: string): string;
}

export interface LiveWidgetRenderOptions {
  readonly now: number;
  readonly frame: number;
  readonly width: number;
  readonly theme: LiveWidgetTheme;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const LINGER_MS = 3_000;

const isLingering = (job: Readonly<Job>, now: number): boolean =>
  (job.state === "completed" || job.state === "failed" || job.state === "cancelled")
  && job.finishedAt !== undefined
  && now < job.finishedAt + LINGER_MS;

const displayJobs = (jobs: readonly Job[], now: number): readonly Job[] => [
  ...jobs.filter((job) => job.state === "running"),
  ...jobs.filter((job) => job.state === "queued"),
  ...jobs.filter((job) => isLingering(job, now)),
];

const durationMs = (job: Readonly<Job>, now: number): number => {
  const start = job.state === "queued" ? job.createdAt : job.startedAt ?? job.createdAt;
  const end = job.state === "running" || job.state === "queued" ? now : job.finishedAt ?? now;
  return Math.max(0, end - start);
};

const formatDuration = (milliseconds: number): string => `${(milliseconds / 1_000).toFixed(1)}s`;

const stateIcon = (job: Readonly<Job>, frame: number, theme: LiveWidgetTheme): string => {
  if (job.state === "running") return theme.fg("accent", SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length]!);
  if (job.state === "queued") return theme.fg("muted", "○");
  if (job.state === "completed") return theme.fg("success", "✓");
  if (job.state === "failed") return theme.fg("error", "✗");
  return theme.fg("dim", "■");
};
```

Add `formatLiveWidgetLines`. It must call `projectJobStatus` for safe profile, task, and activity text; create a header; append a job row and one running activity row; and truncate each full line:

```ts
export function formatLiveWidgetLines(jobs: readonly Job[], options: LiveWidgetRenderOptions): string[] {
  const { now, frame, width, theme } = options;
  const visible = displayJobs(jobs, now);
  if (visible.length === 0) return [];

  const hasActive = visible.some((job) => job.state === "running" || job.state === "queued");
  const headingColor = hasActive ? "accent" : "dim";
  const lines = [theme.fg(headingColor, `${hasActive ? "●" : "○"} Subagents`)];

  visible.forEach((job, index) => {
    const status = projectJobStatus(job, now);
    const isLast = index === visible.length - 1;
    const connector = isLast ? "└─" : "├─";
    const agent = job.state === "running" ? theme.bold(status.agent) : theme.fg("dim", status.agent);
    const duration = `${job.state === "queued" ? "queued " : ""}${formatDuration(durationMs(job, now))}`;
    lines.push(`${theme.fg("dim", connector)} ${stateIcon(job, frame, theme)} ${agent}  ${theme.fg("muted", status.task)} ${theme.fg("dim", `· ${duration}`)}`);

    if (job.state === "running") {
      const activity = status.recentActivity.at(-1)?.summary ?? "thinking…";
      const indent = isLast ? "   " : "│  ";
      lines.push(`${theme.fg("dim", indent)}  ${theme.fg("dim", `⎿ ${activity}`)}`);
    }
  });

  return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
}
```

Do not add controller behavior yet.

- [ ] **Step 4: Run the formatter tests and verify GREEN**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: all six initial formatter tests pass with 0 failures.

- [ ] **Step 5: Add failing tests for turns, tool-use counting, tokens, and duration**

Append focused tests:

```ts
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

```

- [ ] **Step 6: Run the tests and verify the new assertions fail for missing stats**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: FAIL in both statistics tests because the initial formatter emits duration only.

- [ ] **Step 7: Implement compact statistics without changing selection or activity behavior**

Add these helpers above `formatLiveWidgetLines`:

```ts
const formatTokens = (count: number): string => {
  const safe = Math.max(0, count);
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M tokens`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}k tokens`;
  return `${safe} token${safe === 1 ? "" : "s"}`;
};

const formatStats = (job: Readonly<Job>, now: number): string => {
  const parts: string[] = [];
  if (job.usage.turns > 0) parts.push(`↻${job.usage.turns}`);
  const toolUses = job.progress.filter((item) => item.type === "tool" && item.text.startsWith("Started ")).length;
  if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
  const tokens = Math.max(0, job.usage.input + job.usage.output);
  if (tokens > 0) parts.push(formatTokens(tokens));
  const duration = formatDuration(durationMs(job, now));
  parts.push(job.state === "queued" ? `queued ${duration}` : duration);
  return parts.join(" · ");
};
```

Replace the inline duration construction with `formatStats(job, now)`. Keep the final separator as one dim-styled fragment.

- [ ] **Step 8: Run formatter tests and typecheck**

Run:

```sh
npx tsx --test test/live-widget.test.ts
npm run typecheck
```

Expected: all live-widget tests pass and TypeScript exits 0.

- [ ] **Step 9: Commit the pure formatter**

```sh
git add src/live-widget.ts test/live-widget.test.ts
git commit -m "feat: render live subagent tree"
```

---

### Task 2: Add the single-component animation and linger controller through TDD

**Files:**

- Modify: `src/live-widget.ts`
- Modify: `test/live-widget.test.ts`

**Interfaces:**

- Produces: `LiveSubagentsWidgetOptions`
- Produces: `LiveSubagentsWidget.setUi(ui: Pick<ExtensionContext["ui"], "setWidget">): void`
- Produces: `LiveSubagentsWidget.setJobs(jobs: readonly Job[]): void`
- Produces: `LiveSubagentsWidget.dispose(): void`
- Preserves: `formatLiveWidgetLines` from Task 1

- [ ] **Step 1: Add a deterministic fake timer and UI harness**

Append test helpers that capture interval and timeout callbacks, widget registration, and render requests:

```ts
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
```

Import `LiveSubagentsWidget` beside `formatLiveWidgetLines`.

- [ ] **Step 2: Write failing tests for one registration, animation, and progress coalescing**

Append:

```ts
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
```

- [ ] **Step 3: Run the controller test and verify RED**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: FAIL because `LiveSubagentsWidget` is not exported.

- [ ] **Step 4: Implement controller registration and the running interval**

Add the coding-agent type import and extend the existing Pi TUI import:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
```

Add the timer interfaces and controller below the formatter:

```ts
type TimerHandle = unknown;
type WidgetUi = Pick<ExtensionContext["ui"], "setWidget">;

export interface LiveSubagentsWidgetOptions {
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, delay: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
  readonly setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}

export class LiveSubagentsWidget {
  private readonly now: () => number;
  private readonly startInterval: (callback: () => void, delay: number) => TimerHandle;
  private readonly stopInterval: (handle: TimerHandle) => void;
  private readonly startTimeout: (callback: () => void, delay: number) => TimerHandle;
  private readonly stopTimeout: (handle: TimerHandle) => void;
  private ui: WidgetUi | undefined;
  private jobs: readonly Job[] = [];
  private requestRender: (() => void) | undefined;
  private animation: TimerHandle | undefined;
  private expiry: TimerHandle | undefined;
  private expiryDeadline: number | undefined;
  private frame = 0;
  private registered = false;
  private disposed = false;

  constructor(options: LiveSubagentsWidgetOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startInterval = options.setInterval ?? ((callback, delay) => setInterval(callback, delay));
    this.stopInterval = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.startTimeout = options.setTimeout ?? ((callback, delay) => setTimeout(callback, delay));
    this.stopTimeout = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  setUi(ui: WidgetUi): void {
    if (this.disposed || this.ui === ui) return;
    this.clearRegistration();
    this.ui = ui;
    this.refresh(false);
  }

  setJobs(jobs: readonly Job[]): void {
    if (this.disposed) return;
    this.jobs = jobs;
    this.refresh(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopAnimation();
    this.stopExpiry();
    this.clearRegistration();
    this.ui = undefined;
    this.jobs = [];
  }

  private refresh(fromJobUpdate: boolean): void {
    if (this.disposed || !this.ui) return;
    const now = this.now();
    const visible = displayJobs(this.jobs, now);
    if (visible.length === 0) {
      this.stopAnimation();
      this.stopExpiry();
      this.clearRegistration();
      return;
    }

    const wasAnimating = this.animation !== undefined;
    this.ensureRegistration();
    if (visible.some((job) => job.state === "running")) this.ensureAnimation();
    else this.stopAnimation();
    this.syncExpiry(visible, now);
    if (fromJobUpdate && (!wasAnimating || this.animation === undefined)) this.requestRender?.();
  }

  private ensureRegistration(): void {
    if (this.registered || !this.ui) return;
    this.ui.setWidget("simple-subagents", (tui, theme): Component => {
      this.requestRender = () => tui.requestRender();
      return {
        render: (width) => formatLiveWidgetLines(this.jobs, {
          now: this.now(), frame: this.frame, width, theme: theme as LiveWidgetTheme,
        }),
        invalidate: () => {},
      };
    }, { placement: "aboveEditor" });
    this.registered = true;
  }

  private ensureAnimation(): void {
    if (this.animation !== undefined) return;
    this.animation = this.startInterval(() => {
      if (this.disposed) return;
      this.frame = (this.frame + 1) % SPINNER.length;
      this.requestRender?.();
    }, 80);
  }

  private stopAnimation(): void {
    if (this.animation === undefined) return;
    this.stopInterval(this.animation);
    this.animation = undefined;
  }
```

Add the minimum concrete methods required by the current animation test. Expiry scheduling is intentionally a no-op until its behavior has a failing test:

```ts
  private syncExpiry(_visible: readonly Job[], _now: number): void {}

  private stopExpiry(): void {
    if (this.expiry !== undefined) this.stopTimeout(this.expiry);
    this.expiry = undefined;
    this.expiryDeadline = undefined;
  }

  private clearRegistration(): void {
    this.requestRender = undefined;
    if (!this.registered) return;
    this.ui?.setWidget("simple-subagents", undefined);
    this.registered = false;
  }
}
```

The next RED test introduces expiry as a separate behavior.

- [ ] **Step 5: Run the controller test and verify GREEN**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: all current tests pass.

- [ ] **Step 6: Write failing tests for nearest expiry, final removal, immediate collected removal, and stale callback cleanup**

Append:

```ts
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
  assert.equal([...h.clock.timeouts.values()][0]?.delay, 1_000);

  h.clock.now = 11_000;
  [...h.clock.timeouts.values()][0]!.callback();
  assert.equal(h.clock.timeouts.size, 1);
  assert.equal([...h.clock.timeouts.values()][0]?.delay, 1_000);
  assert.equal(plain(h.render().join("\n")).includes("first"), false);
  assert.equal(plain(h.render().join("\n")).includes("second"), true);

  h.clock.now = 12_000;
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
```

- [ ] **Step 7: Run tests and verify RED for missing expiry scheduling**

Run:

```sh
npx tsx --test test/live-widget.test.ts
```

Expected: FAIL because the temporary `syncExpiry` does not schedule the nearest deadline.

- [ ] **Step 8: Implement exact nearest-deadline scheduling and cleanup**

Replace the temporary methods with:

```ts
  private syncExpiry(visible: readonly Job[], now: number): void {
    const deadlines = visible
      .filter((job) => job.state === "completed" || job.state === "failed" || job.state === "cancelled")
      .flatMap((job) => job.finishedAt === undefined ? [] : [job.finishedAt + LINGER_MS]);
    const deadline = deadlines.length === 0 ? undefined : Math.min(...deadlines);
    if (deadline === this.expiryDeadline) return;
    this.stopExpiry();
    if (deadline === undefined) return;
    this.expiryDeadline = deadline;
    this.expiry = this.startTimeout(() => {
      if (this.disposed) return;
      this.expiry = undefined;
      this.expiryDeadline = undefined;
      this.refresh(false);
      this.requestRender?.();
    }, Math.max(0, deadline - now));
  }

  private stopExpiry(): void {
    if (this.expiry !== undefined) this.stopTimeout(this.expiry);
    this.expiry = undefined;
    this.expiryDeadline = undefined;
  }

  private clearRegistration(): void {
    this.requestRender = undefined;
    if (!this.registered) return;
    this.ui?.setWidget("simple-subagents", undefined);
    this.registered = false;
  }
}
```

In the timeout callback, call `refresh(false)` first. Only request a render if the widget remains registered; `clearRegistration` clears the callback when no rows remain.

- [ ] **Step 9: Run controller tests, then all formatter tests and typecheck**

Run:

```sh
npx tsx --test test/live-widget.test.ts
npm run typecheck
```

Expected: all live-widget tests pass and TypeScript exits 0.

- [ ] **Step 10: Commit the tested controller**

```sh
git add src/live-widget.ts test/live-widget.test.ts
git commit -m "feat: animate live subagent widget"
```

---

### Task 3: Integrate session lifecycle, preserve the dashboard, and document the widget

**Files:**

- Modify: `src/dashboard.ts:1-80,364-458`
- Modify: `test/dashboard.test.ts:1-150, registration lifecycle tests near the end`
- Modify: `README.md:28-30`
- Test: `test/live-widget.test.ts`
- Test: `test/dashboard.test.ts`

**Interfaces:**

- Consumes: `LiveSubagentsWidget` from Task 2
- Preserves: `SubagentsDashboard`
- Preserves: `registerSubagentsUi(pi: ExtensionAPI, manager: JobManager): () => void`
- Removes internal automatic-widget-only helpers: `AttentionCounts`, `attentionCounts`, and `formatWidgetLines`

- [ ] **Step 1: Rewrite the registration test to express the new controller behavior before integration**

In `test/dashboard.test.ts`:

1. Remove `formatWidgetLines` from the dashboard import.
2. Remove the old `formats compact widget attention counts...` test.
3. Extend `FakeUi.setWidget` so the test can retain the latest factory and instantiate its component with a fake TUI request counter.
4. Replace `registration updates and clears the compact widget from live manager changes` with a test named `registration installs one live widget and clears it after work disappears`.

The replacement test must:

```ts
const manager = new FakeManager([]);
const pi = new FakePi();
const cleanup = registerSubagentsUi(pi as never, manager as never);
await pi.emit("session_start", context(pi));
manager.setJobs([job("job-1", "running")]);

assert.equal(pi.ui.widgets.filter((entry) => typeof entry === "function").length, 1);
const factory = pi.ui.widgets.findLast((entry) => typeof entry === "function") as any;
const component = factory({ requestRender: () => { pi.ui.renderRequests += 1; }, terminal: { columns: 100 } }, theme);
assert.match(plain(component.render(100).join("\n")), /Subagents[\s\S]*job-1/u);

manager.setJobs([job("job-1", "collected")]);
assert.equal(pi.ui.widgets.at(-1), undefined);
cleanup();
```

Use the existing fake classes rather than adding production test hooks.

- [ ] **Step 2: Run the focused dashboard test and verify RED**

Run:

```sh
npx tsx --test test/dashboard.test.ts
```

Expected: FAIL because `registerSubagentsUi` still installs the old count formatter and replaces its factory on manager changes.

- [ ] **Step 3: Replace only the automatic widget registration with `LiveSubagentsWidget`**

At the top of `src/dashboard.ts`:

- Import `LiveSubagentsWidget` from `./live-widget.js`.
- Remove `AttentionCounts`, `attentionCounts`, and `formatWidgetLines`.
- Keep all `SubagentsDashboard` symbols and imports needed by the custom dashboard.

Inside `registerSubagentsUi` replace `widgetContext` with:

```ts
let liveWidget: LiveSubagentsWidget | undefined;
```

Make `clearWidget` unsubscribe first, dispose the controller, and then clear references:

```ts
const clearWidget = (): void => {
  removeWidgetSubscription?.();
  removeWidgetSubscription = undefined;
  liveWidget?.dispose();
  liveWidget = undefined;
};
```

Replace only the widget portion of `session_start` with:

```ts
if (cleanedUp || ctx.mode !== "tui") return;
const widget = new LiveSubagentsWidget();
liveWidget = widget;
widget.setUi(ctx.ui);
let widgetClosed = false;
const unsubscribe = manager.subscribe((jobs) => {
  if (!widgetClosed) widget.setJobs(jobs);
});
removeWidgetSubscription = () => {
  if (widgetClosed) return;
  widgetClosed = true;
  unsubscribe();
};
```

Do not change command registration, active dashboard cleanup, or the custom component.

- [ ] **Step 4: Run dashboard and live-widget tests and verify GREEN**

Run:

```sh
npx tsx --test test/live-widget.test.ts test/dashboard.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Add session replacement and shutdown ordering assertions**

Update the existing registration lifecycle tests so their fake lifecycle event arrays verify this order:

```text
old manager unsubscribe
old live widget clear
new manager subscribe
```

Update the extension cleanup test to verify the final `setWidget("simple-subagents", undefined)` occurs before `manager.shutdown()`. Keep the existing idempotence assertion by invoking cleanup twice.

- [ ] **Step 6: Run the lifecycle tests and verify they pass**

Run:

```sh
npx tsx --test test/dashboard.test.ts test/tools.test.ts
```

Expected: all selected tests pass. `/subagents` interaction and extension shutdown behavior remain covered.

- [ ] **Step 7: Document the automatic widget without changing tool guidance**

In `README.md`, after the first usage sentence describing natural requests and `/subagents`, add this paragraph:

```md
While jobs are queued or running, an above-editor tree shows each active subagent, its latest bounded activity, turns, tool uses, tokens, and elapsed time. Running rows use an animated spinner. Completed, failed, and cancelled rows remain visible for three seconds; `/subagents` remains the durable inbox view until the parent collects or discards a result.
```

Do not claim that the widget shows full conversations or supports navigation.

- [ ] **Step 8: Run proactive diagnostics on edited TypeScript files**

Run the LSP diagnostics tool for:

```text
src/live-widget.ts
test/live-widget.test.ts
src/dashboard.ts
test/dashboard.test.ts
```

Resolve every new error before continuing. Do not alter unrelated files to address pre-existing warnings.

- [ ] **Step 9: Run complete verification**

Run:

```sh
npm test
npm run typecheck
```

Expected: the complete test suite reports 0 failures, the two real-Pi integration tests may remain skipped, and TypeScript exits 0.

Then run `lens_diagnostics` with `mode=all` and confirm no blocking errors remain in edited files.

- [ ] **Step 10: Review the final diff against the design**

Run:

```sh
git diff --check
git diff --stat master...HEAD
git status --short
```

Check these requirements directly in the diff:

- The old one-line automatic count is gone.
- `/subagents` rendering and controls are unchanged.
- The animation interval exists only in `src/live-widget.ts` and only for running jobs.
- The linger timeout uses the nearest absolute three-second deadline.
- All controller cleanup paths are idempotent.
- README wording matches actual data and behavior.

- [ ] **Step 11: Commit integration and documentation**

```sh
git add src/dashboard.ts test/dashboard.test.ts README.md
git commit -m "feat: show live subagent activity"
```

- [ ] **Step 12: Request final code review**

Use the requesting-code-review skill against `master...HEAD`. Address only findings that are supported by the approved design and verified behavior. Repeat complete verification after any review-driven edit.
