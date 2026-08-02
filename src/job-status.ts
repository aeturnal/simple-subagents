import { truncateUtf8 } from "./output.js";
import type { AccessMode, Job, JobState, UsageStats } from "./types.js";

export const STATUS_ACTIVITY_LIMIT = 3;
export const STATUS_JOB_LIMIT = 20;
export const STATUS_PREVIEW_MAX_BYTES = 512;
export const STATUS_PREVIEW_MAX_GRAPHEMES = 160;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sanitizeTerminalText(text: string, preserveSgr = false): string {
  let safe = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 0x1b && text[index + 1] === "]") {
      index += 2;
      while (index < text.length && text.charCodeAt(index) !== 0x07 && !(text.charCodeAt(index) === 0x1b && text[index + 1] === "\\")) index += 1;
      index += text.charCodeAt(index) === 0x1b ? 2 : 1;
      continue;
    }
    if (code === 0x1b && text[index + 1] === "[") {
      let end = index + 2;
      while (end < text.length && !(text.charCodeAt(end) >= 0x40 && text.charCodeAt(end) <= 0x7e)) end += 1;
      const sequence = text.slice(index, Math.min(text.length, end + 1));
      const final = text[end];
      const parameters = text.slice(index + 2, end);
      if (preserveSgr && final === "m" && /^[0-9:;]*$/.test(parameters)) safe += sequence;
      index = Math.min(text.length, end + 1);
      continue;
    }
    if (code === 0x1b) { index += Math.min(2, text.length - index); continue; }
    const value = text[index] ?? "";
    if (value === "\n") safe += value;
    else if (value === "\t") safe += "   ";
    else if (value !== "\r" && code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) safe += value;
    index += 1;
  }
  return safe;
}

export function boundedPreview(text: string, maxBytes = STATUS_PREVIEW_MAX_BYTES, maxGraphemes = STATUS_PREVIEW_MAX_GRAPHEMES): string {
  const normalized = sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();
  let bounded = "";
  let count = 0;
  for (const segment of graphemes.segment(normalized)) {
    if (count >= maxGraphemes) break;
    bounded += segment.segment;
    count += 1;
  }
  return truncateUtf8(bounded, maxBytes).text;
}

export interface StatusActivity {
  timestamp: number;
  kind: "assistant" | "tool" | "diagnostic";
  summary: string;
}

export interface JobStatus {
  id: string;
  state: JobState;
  task: string;
  agent: string;
  access: AccessMode;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  queueDurationMs?: number;
  runDurationMs?: number;
  launchModel?: string;
  launchThinking?: string;
  reportedModel?: string;
  usage: UsageStats;
  recentActivity: StatusActivity[];
  resultReady: boolean;
  hasError: boolean;
  captureNotices: string[];
}

export interface StatusListResult {
  statuses: JobStatus[];
  omitted: number;
}

const clampDuration = (end: number, start: number): number => Math.max(0, end - start);

const thinkingSelection = (job: Readonly<Job>): string => {
  const source = job.launchThinkingSource === "job" ? "job override"
    : job.launchThinkingSource === "parent" ? "parent session"
      : job.launchThinkingSource === "legacy" ? "legacy profile/parent behavior"
        : "model or Pi default";
  return job.launchThinkingLevel ? `${job.launchThinkingLevel} (${source})` : source;
};

const captureNotice = (label: string, truncation?: { originalBytes: number; keptBytes: number }): string | undefined =>
  truncation && `${label} capture truncated: retained ${truncation.keptBytes} of ${truncation.originalBytes} bytes.`;

export function projectJobStatus(job: Readonly<Job>, now: number): JobStatus {
  const isTerminal = job.state === "completed" || job.state === "failed" || job.state === "cancelled" || job.state === "collected" || job.state === "discarded";
  const queueEnd = job.state === "queued" ? now : job.startedAt;
  const runEnd = job.state === "running" ? now : isTerminal ? job.finishedAt : undefined;
  const latestPartial = [...job.progress].reverse().find((item) => item.type === "text");
  const recentActivity = job.progress.flatMap((item): StatusActivity[] => {
    const text = boundedPreview(item.text);
    if (!text) return [];
    if (item.type === "text") return [{ timestamp: item.timestamp, kind: "assistant", summary: text }];
    if (item.type === "tool") {
      const match = /^(Started|Updated|Completed)\s+(.+)$/u.exec(text);
      return [{
        timestamp: item.timestamp,
        kind: "tool",
        summary: match ? boundedPreview(`${match[1]} ${match[2]}`) : "Tool activity",
      }];
    }
    return [{ timestamp: item.timestamp, kind: "diagnostic", summary: text }];
  }).slice(-STATUS_ACTIVITY_LIMIT);
  const captureNotices = [
    captureNotice("Output", job.outputTruncation ?? job.truncation),
    captureNotice("Stderr", job.stderrTruncation),
    captureNotice("Error", job.errorTruncation),
    captureNotice("Partial output", latestPartial?.truncation),
  ].filter((notice): notice is string => notice !== undefined);

  return {
    id: boundedPreview(job.id),
    state: job.state,
    task: boundedPreview(job.request.task),
    agent: boundedPreview(job.profile.name),
    access: job.request.writeAccess ? "write" : "read-only",
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    queueDurationMs: queueEnd === undefined ? undefined : clampDuration(queueEnd, job.createdAt),
    runDurationMs: job.startedAt === undefined || runEnd === undefined ? undefined : clampDuration(runEnd, job.startedAt),
    launchModel: job.launchModel && boundedPreview(job.launchModel),
    launchThinking: thinkingSelection(job),
    reportedModel: job.model && boundedPreview(job.model),
    usage: structuredClone(job.usage),
    recentActivity,
    resultReady: job.state === "completed" || job.state === "failed" || job.state === "cancelled",
    hasError: job.state === "failed" || Boolean(job.errorMessage || job.stderr || job.errorTruncation || job.stderrTruncation),
    captureNotices,
  };
}

export function selectStatusList(jobs: readonly Job[], now: number): StatusListResult {
  const group = (state: JobState): number =>
    state === "queued" || state === "running" ? 0
      : state === "completed" || state === "failed" || state === "cancelled" ? 1
        : 2;
  const statuses = jobs
    .map((job, index) => ({ index, status: projectJobStatus(job, now) }))
    .sort((left, right) => group(left.status.state) - group(right.status.state) || left.index - right.index)
    .map(({ status }) => status);
  return { statuses: statuses.slice(0, STATUS_JOB_LIMIT), omitted: Math.max(0, statuses.length - STATUS_JOB_LIMIT) };
}

const durationText = (durationMs: number): string => {
  const seconds = Math.floor(Math.max(0, durationMs) / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const durationDescription = (status: JobStatus): string | undefined => {
  if (status.state === "queued" && status.queueDurationMs !== undefined) return `queued for ${durationText(status.queueDurationMs)}`;
  if (status.state === "running" && status.runDurationMs !== undefined) return `running for ${durationText(status.runDurationMs)}`;
  if (status.runDurationMs !== undefined) return `ran for ${durationText(status.runDurationMs)}`;
  if (status.queueDurationMs !== undefined) return `queued for ${durationText(status.queueDurationMs)}`;
  return undefined;
};

const activityAge = (timestamp: number, now: number): string => {
  const age = clampDuration(now, timestamp);
  return age < 1_000 ? "now" : `${durationText(age)} ago`;
};

const usageText = (usage: UsageStats): string =>
  `input ${usage.input}, output ${usage.output}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}, cost ${usage.cost}, turns ${usage.turns}`;

export function formatSingleJobStatus(status: JobStatus, now: number): string {
  const duration = durationDescription(status);
  const lines = [
    `${status.id} — ${status.state}${duration ? ` · ${duration}` : ""}`,
    `Task: ${status.task}`,
    `Agent: ${status.agent} · Access: ${status.access}`,
    `Launch model: ${status.launchModel ?? "model or Pi default"}`,
    `Launch thinking: ${status.launchThinking ?? "model or Pi default"}`,
    ...(status.reportedModel && status.reportedModel !== status.launchModel ? [`Reported model: ${status.reportedModel}`] : []),
    `Usage: ${usageText(status.usage)}`,
    ...(status.recentActivity.length ? ["Recent activity:", ...status.recentActivity.map((item) => `  ${activityAge(item.timestamp, now)}  ${item.summary}`)] : ["Recent activity: No activity reported yet"]),
    ...(status.captureNotices.length ? ["Capture limits:", ...status.captureNotices.map((notice) => `  ${notice}`)] : []),
    ...(status.hasError ? ["Error reported."] : []),
    ...(status.resultReady ? [`Result ready — collect ${status.id} to read it.`] : []),
  ];
  return lines.join("\n");
}

export function formatJobStatusList(result: StatusListResult, now: number): string {
  const lines = result.statuses.flatMap((status) => {
    const duration = durationDescription(status);
    const activity = status.recentActivity.at(-1);
    return [
      `${status.id} — ${status.state}${duration ? ` · ${duration}` : ""} · ${status.task}`,
      activity ? `  ${activityAge(activity.timestamp, now)}  ${activity.summary}` : "  No activity reported yet",
    ];
  });
  if (result.omitted) lines.push(`${result.omitted} additional job${result.omitted === 1 ? "" : "s"} omitted.`);
  return lines.length ? lines.join("\n") : "No jobs.";
}
