import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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
const LINGER_MS = 5_000;

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
  const model = (job.model ?? job.launchModel)?.split("/").at(-1);
  if (model) parts.push(model);
  if (job.launchThinkingLevel) parts.push(job.launchThinkingLevel);
  const duration = formatDuration(durationMs(job, now));
  parts.push(job.state === "queued" ? `queued ${duration}` : duration);
  return parts.join(" · ");
};

const tailToWidth = (text: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  const textWidth = visibleWidth(text);
  return textWidth <= safeWidth ? text : sliceByColumn(text, textWidth - safeWidth, safeWidth, true);
};

const formatJobRow = (prefix: string, task: string, details: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  const prefixWidth = visibleWidth(prefix);
  if (prefixWidth >= safeWidth) return truncateToWidth(prefix, safeWidth, "");

  const detailsWidth = visibleWidth(details);
  const taskWidth = safeWidth - prefixWidth - 3 - detailsWidth;
  if (taskWidth > 0) return `${prefix}  ${truncateToWidth(task, taskWidth)} ${details}`;
  if (safeWidth >= prefixWidth + 2 + detailsWidth) return `${prefix}  ${details}`;
  return `${prefix}${tailToWidth(`  ${details}`, safeWidth - prefixWidth)}`;
};

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
    const prefix = `${theme.fg("dim", connector)} ${stateIcon(job, frame, theme)} ${agent}`;
    const task = theme.fg("muted", status.task);
    const details = theme.fg("dim", `· ${formatStats(job, now)}`);
    lines.push(formatJobRow(prefix, task, details, width));

    if (job.state === "running") {
      const activity = status.recentActivity.at(-1)?.summary ?? "thinking…";
      const indent = isLast ? "   " : "│  ";
      lines.push(`${theme.fg("dim", indent)}  ${theme.fg("dim", `⎿ ${activity}`)}`);
    }
  });

  return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
}

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
