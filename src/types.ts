export interface SimpleSubagentsConfig {
  confirmWrites: boolean;
}

export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "collected" | "discarded";
export type AccessMode = "read-only" | "write";

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
  type: "text" | "tool" | "diagnostic";
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

export const isSettled = (state: JobState): boolean =>
  state === "completed" || state === "failed" || state === "cancelled" || state === "collected" || state === "discarded";
