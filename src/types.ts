import { inspectJobState } from "./job-lifecycle.js";

export interface SimpleSubagentsConfig {
  confirmWrites: boolean;
}

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "collected" | "discarded";
export type AccessMode = "read-only" | "write";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type LaunchThinkingSource = "job" | "parent" | "model_or_pi_default" | "legacy";

export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  source: "builtin" | "user";
  filePath?: string;
}

export interface JobRequest {
  task: string;
  agent: string;
  writeAccess: boolean;
  cwd?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface TextTruncation {
  originalBytes: number;
  keptBytes: number;
}

export interface ProgressItem {
  type: "text" | "tool" | "diagnostic" | "model";
  text: string;
  timestamp: number;
  truncation?: TextTruncation;
}

export interface Job {
  id: string;
  request: JobRequest;
  profile: AgentProfile;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: ProgressItem[];
  output: string;
  stderr: string;
  usage: UsageStats;
  launchModel?: string;
  launchThinkingLevel?: ThinkingLevel;
  launchThinkingSource?: LaunchThinkingSource;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  errorTruncation?: TextTruncation;
  malformedEventCount: number;
  malformedEventSamples?: string[];
  outputTruncation?: TextTruncation;
  stderrTruncation?: TextTruncation;
  /** @deprecated Use outputTruncation for producer capture metadata. */
  truncation?: TextTruncation;
}

export const isSettled = (state: JobState): boolean => inspectJobState(state).settled;
