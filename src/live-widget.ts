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
    const stats = formatStats(job, now);
    lines.push(`${theme.fg("dim", connector)} ${stateIcon(job, frame, theme)} ${agent}  ${theme.fg("muted", status.task)} ${theme.fg("dim", `· ${stats}`)}`);

    if (job.state === "running") {
      const activity = status.recentActivity.at(-1)?.summary ?? "thinking…";
      const indent = isLast ? "   " : "│  ";
      lines.push(`${theme.fg("dim", indent)}  ${theme.fg("dim", `⎿ ${activity}`)}`);
    }
  });

  return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
}
