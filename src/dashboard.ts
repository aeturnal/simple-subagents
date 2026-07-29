import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  type Component,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { JobManager } from "./job-manager.js";
import { formatCollectedResult } from "./output.js";
import type { Job } from "./types.js";

type DashboardTheme = { fg(color: "accent" | "dim" | "error" | "muted" | "success" | "warning", text: string): string; bold(text: string): string };

type AttentionCounts = { queued: number; running: number; ready: number };

const attentionCounts = (jobs: readonly Job[]): AttentionCounts => jobs.reduce<AttentionCounts>((counts, job) => {
  if (job.state === "queued") counts.queued += 1;
  else if (job.state === "running") counts.running += 1;
  else if (["completed", "failed", "cancelled"].includes(job.state)) counts.ready += 1;
  return counts;
}, { queued: 0, running: 0, ready: 0 });

export function formatWidgetLines(jobs: readonly Job[], theme: DashboardTheme): string[] {
  const counts = attentionCounts(jobs);
  const parts = [
    counts.queued > 0 ? `${counts.queued} queued` : "",
    counts.running > 0 ? `${counts.running} running` : "",
    counts.ready > 0 ? `${counts.ready} ready` : "",
  ].filter(Boolean);
  if (parts.length === 0) return [];
  return [theme.fg("accent", "● Subagents") + theme.fg("dim", ` · ${parts.join(" · ")}`)];
}

export interface SubagentsDashboardOptions {
  jobs: readonly Job[];
  manager: JobManager;
  pi: ExtensionAPI;
  theme: DashboardTheme;
  requestRender(): void;
  notify(message: string): void;
  close(): void;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export class SubagentsDashboard implements Component {
  private jobs: readonly Job[];
  private selected = 0;
  private detailed = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private refreshTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private disposed = false;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;

  constructor(private readonly options: SubagentsDashboardOptions) {
    this.jobs = options.jobs;
    this.now = options.now ?? Date.now;
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
    this.updateRefreshTimer();
  }

  setJobs(jobs: readonly Job[]): void {
    const priorJobs = this.visibleJobs();
    const priorIndex = this.selected;
    const selectedId = priorJobs[priorIndex]?.id;
    this.jobs = jobs;
    const visible = this.visibleJobs();
    const preservedIndex = selectedId === undefined ? -1 : visible.findIndex((job) => job.id === selectedId);
    this.selected = preservedIndex >= 0 ? preservedIndex : Math.min(priorIndex, Math.max(0, visible.length - 1));
    this.updateRefreshTimer();
    this.changed();
  }

  handleInput(data: string): void {
    const jobs = this.visibleJobs();
    if (matchesKey(data, Key.up) && this.selected > 0) this.selected -= 1;
    else if (matchesKey(data, Key.down) && this.selected < jobs.length - 1) this.selected += 1;
    else if (matchesKey(data, Key.enter)) this.detailed = !this.detailed;
    else if (matchesKey(data, Key.escape)) {
      this.dispose();
      this.options.close();
      return;
    } else {
      const selected = jobs[this.selected];
      if (selected && matchesKey(data, "c") && (selected.state === "queued" || selected.state === "running")) {
        try {
          void this.options.manager.cancel(selected.id).catch(() => this.actionFailed("cancel"));
        } catch {
          this.actionFailed("cancel");
        }
        return;
      } else if (selected && matchesKey(data, "x") && this.isInbox(selected)) {
        try {
          const current = this.options.manager.list().find((job) => job.id === selected.id);
          if (!current || !this.isInbox(current)) throw new Error("Job is no longer collectable");
          const formatted = formatCollectedResult(selected);
          this.options.pi.sendMessage({
            customType: "simple-subagents-result",
            content: formatted,
            display: true,
            details: { jobId: selected.id },
          }, { deliverAs: "nextTurn" });
          this.options.manager.collect(selected.id);
        } catch {
          this.actionFailed("collect");
        }
        return;
      } else if (selected && matchesKey(data, "d") && this.isInbox(selected)) {
        try {
          this.options.manager.discard(selected.id);
        } catch {
          this.actionFailed("discard");
        }
        return;
      } else return;
    }
    this.changed();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
    const line = (value: string): string => truncateToWidth(value, width);
    const jobs = this.visibleJobs();
    this.selected = Math.min(this.selected, Math.max(0, jobs.length - 1));
    const lines: string[] = [line(this.options.theme.bold("Subagents"))];
    const groups: Array<[string, Job[]]> = [
      ["QUEUED", jobs.filter((job) => job.state === "queued")],
      ["RUNNING", jobs.filter((job) => job.state === "running")],
      ["INBOX", jobs.filter((job) => this.isInbox(job))],
    ];
    for (const [heading, group] of groups) {
      if (group.length === 0) continue;
      lines.push(line(this.options.theme.fg("dim", heading)));
      for (const item of group) lines.push(line(this.row(item, jobs[this.selected]?.id === item.id)));
    }
    if (jobs.length === 0) lines.push(line(this.options.theme.fg("dim", "No subagent jobs.")));
    if (this.detailed && jobs[this.selected]) lines.push(...this.detail(jobs[this.selected]!, width));
    lines.push(line("↑↓ navigate · enter inspect · c cancel · x collect · d discard · esc close"));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      this.clearIntervalFn(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private visibleJobs(): Job[] {
    return [
      ...this.jobs.filter((job) => job.state === "queued"),
      ...this.jobs.filter((job) => job.state === "running"),
      ...this.jobs.filter((job) => this.isInbox(job)),
    ];
  }

  private isInbox(job: Job): boolean {
    return job.state === "completed" || job.state === "failed" || job.state === "cancelled";
  }

  private row(job: Job, selected: boolean): string {
    const marker = selected ? this.options.theme.fg("accent", "> ") : "  ";
    const writable = job.request.writeAccess ? "W " : "";
    const elapsed = job.state === "running" && job.startedAt ? ` ${Math.max(0, Math.floor((this.now() - job.startedAt) / 1000))}s` : "";
    return `${marker}${job.id} ${writable}${job.state}${elapsed} · ${job.request.task}`;
  }

  private detail(job: Job, width: number): string[] {
    const lines = [this.options.theme.bold(`DETAIL ${job.id}`)];
    const wrap = (label: string, value: string): void => {
      const available = Math.max(1, width - label.length);
      const wrapped = wrapTextWithAnsi(value, available);
      lines.push(`${label}${wrapped.shift() ?? ""}`);
      lines.push(...wrapped.map((part) => " ".repeat(label.length) + part));
    };
    wrap("Task: ", job.request.task);
    wrap("Profile: ", job.profile.name);
    wrap("Access: ", job.request.writeAccess ? "write" : "read-only");
    wrap("Created: ", new Date(job.createdAt).toISOString());
    wrap("Started: ", job.startedAt ? new Date(job.startedAt).toISOString() : "not started");
    wrap("Finished: ", job.finishedAt ? new Date(job.finishedAt).toISOString() : "not finished");
    wrap("Progress: ", job.progress.slice(-3).map((item) => item.text).join(" · ") || "none");
    const latestPartial = [...job.progress].reverse().find((item) => item.type === "text");
    wrap("Output: ", job.output || "none");
    const outputTruncation = job.outputTruncation ?? job.truncation;
    wrap("Output capture: ", outputTruncation ? `${outputTruncation.keptBytes} of ${outputTruncation.originalBytes} bytes retained` : "not truncated");
    wrap("Stderr: ", job.stderr || "none");
    wrap("Stderr capture: ", job.stderrTruncation ? `${job.stderrTruncation.keptBytes} of ${job.stderrTruncation.originalBytes} bytes retained` : "not truncated");
    wrap("Error: ", job.errorMessage || "none");
    wrap("Error capture: ", job.errorTruncation ? `${job.errorTruncation.keptBytes} of ${job.errorTruncation.originalBytes} bytes retained` : "not truncated");
    wrap("Partial output capture: ", latestPartial?.truncation ? `${latestPartial.truncation.keptBytes} of ${latestPartial.truncation.originalBytes} bytes retained` : "not truncated");
    wrap("Malformed: ", `${job.malformedEventCount} (${job.malformedEventSamples?.join(", ") || "none"})`);
    wrap("Usage: ", `input ${job.usage.input}, output ${job.usage.output}, cache ${job.usage.cacheRead + job.usage.cacheWrite}, ${job.usage.turns} turns`);
    wrap("Truncated: ", job.truncation ? `${job.truncation.keptBytes} of ${job.truncation.originalBytes} bytes retained` : "not truncated");
    return lines.map((item) => truncateToWidth(item, width));
  }

  private updateRefreshTimer(): void {
    const hasRunningJobs = this.jobs.some((job) => job.state === "running");
    if (hasRunningJobs && this.refreshTimer === undefined) this.refreshTimer = this.setIntervalFn(() => this.changed(), 1_000);
    else if (!hasRunningJobs && this.refreshTimer !== undefined) {
      this.clearIntervalFn(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private actionFailed(action: "cancel" | "collect" | "discard"): void {
    if (this.disposed) return;
    this.options.notify(`Could not ${action} subagent job.`);
    this.setJobs(this.options.manager.list());
  }

  private changed(): void {
    this.invalidate();
    this.options.requestRender();
  }
}

export function registerSubagentsUi(pi: ExtensionAPI, manager: JobManager): () => void {
  let widgetContext: ExtensionContext | undefined;
  let removeWidgetSubscription: (() => void) | undefined;

  const clearWidget = (): void => {
    removeWidgetSubscription?.();
    removeWidgetSubscription = undefined;
    if (widgetContext?.mode === "tui") widgetContext.ui.setWidget("simple-subagents", undefined);
    widgetContext = undefined;
  };

  pi.registerMessageRenderer("simple-subagents-result", (message, { outputPad }) => {
    const content = typeof message.content === "string" ? message.content : "Subagent result.";
    return new Markdown(content, outputPad, 0, getMarkdownTheme());
  });

  pi.registerCommand("subagents", {
    description: "Open the subagent inbox dashboard",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("The subagents dashboard requires interactive mode.", "warning");
        return;
      }
      let unsubscribe: (() => void) | undefined;
      let component: SubagentsDashboard | undefined;
      let closed = false;
      const close = (done: () => void): void => {
        if (closed) return;
        closed = true;
        component?.dispose();
        unsubscribe?.();
        unsubscribe = undefined;
        done();
      };
      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          component = new SubagentsDashboard({
            jobs: manager.list(),
            manager,
            pi,
            theme,
            requestRender: () => tui.requestRender(),
            notify: (message) => ctx.ui.notify(message, "error"),
            close: () => close(done),
          });
          unsubscribe = manager.subscribe((jobs) => {
            component?.setJobs(jobs);
          });
          return component;
        });
      } finally {
        if (!closed) {
          closed = true;
          component?.dispose();
          unsubscribe?.();
          unsubscribe = undefined;
        }
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    clearWidget();
    if (ctx.mode !== "tui") return;
    widgetContext = ctx;
    removeWidgetSubscription = manager.subscribe((jobs) => {
      const counts = attentionCounts(jobs);
      if (counts.queued + counts.running + counts.ready === 0) {
        ctx.ui.setWidget("simple-subagents", undefined);
        return;
      }
      ctx.ui.setWidget("simple-subagents", (_tui, theme) => ({
        render: (width) => formatWidgetLines(jobs, theme).map((line) => truncateToWidth(line, width)),
        invalidate: () => {},
      }));
    });
  });

  return clearWidget;
}
