import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { JobManager, type WaitJobStatus, type WaitResult, type WaitUntil } from "./job-manager.js";
import { capCollectedPayload, formatCollectedResult } from "./output.js";
import { buildPublicAgentDiscovery, formatUnknownProfileDiagnostic, type PublicAgentProfile } from "./profile-discovery.js";
import { THINKING_LEVELS, type AgentProfile, type Job, type JobRequest } from "./types.js";

const MODEL_PATTERN = "^(?!\\s)(?![\\s\\S]*\\s$)[^\\u0000-\\u001f\\u007f-\\u009f]+$";

const StartTask = Type.Object({
  task: Type.String({ minLength: 1 }),
  agent: Type.Optional(Type.String({ default: "generic" })),
  writeAccess: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String()),
  model: Type.Optional(Type.String({ minLength: 1, pattern: MODEL_PATTERN })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS)),
});

export const StartParams = Type.Object({
  tasks: Type.Array(StartTask, { minItems: 1, maxItems: 8 }),
});
export const AgentsParams = Type.Object({}, { additionalProperties: false });
export const StatusParams = Type.Object({ id: Type.Optional(Type.String()) });
export const ControlParams = Type.Object({
  action: StringEnum(["cancel", "collect", "discard"] as const),
  ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
});
export const WaitParams = Type.Object({
  ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  until: Type.Optional(StringEnum(["any", "all"] as const, { default: "all" })),
  timeoutMs: Type.Optional(Type.Integer({
    minimum: 100,
    maximum: 300_000,
    default: 60_000,
  })),
});

export type StartInput = Static<typeof StartParams>;
export type AgentsInput = Static<typeof AgentsParams>;
export type StatusInput = Static<typeof StatusParams>;
export type ControlInput = Static<typeof ControlParams>;
export type WaitInput = Static<typeof WaitParams>;
export type WriteConfirmation = "approved" | "declined" | "unavailable";

export interface ToolServices {
  manager: JobManager;
  getProfiles(): Promise<ReadonlyMap<string, AgentProfile>>;
  confirmWritable(requests: readonly JobRequest[], ctx: ExtensionContext): Promise<WriteConfirmation>;
  defaults(ctx: ExtensionContext): { cwd: string; parentModel?: string; thinkingLevel?: string };
}

export interface ToolDetails {
  jobs: Job[];
  diagnostics: string[];
  operation?: "agents" | "start" | "status" | "wait" | "cancel" | "collect" | "discard";
  profiles?: PublicAgentProfile[];
  omittedProfiles?: number;
}

export type WaitToolDetails = WaitResult;

export interface AgentsToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails & {
    operation: "agents";
    profiles: PublicAgentProfile[];
    omittedProfiles: number;
  };
}

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails | WaitToolDetails;
}

const response = (
  content: string,
  jobs: readonly Job[] = [],
  diagnostics: string[] = [],
  operation?: ToolDetails["operation"],
): ToolResponse & { details: ToolDetails } => ({
  content: [{ type: "text", text: content }],
  details: { jobs: [...jobs], diagnostics, operation },
});

const toRequest = (task: StartInput["tasks"][number]): JobRequest => ({
  task: task.task,
  agent: task.agent ?? "generic",
  writeAccess: task.writeAccess ?? false,
  cwd: task.cwd,
  model: task.model,
  thinkingLevel: task.thinkingLevel,
});

const summary = (jobs: readonly Job[]): string => jobs.map((job) => `${job.id} (${job.state})`).join(", ");

export async function listAgents(services: ToolServices): Promise<AgentsToolResponse> {
  const profiles = await services.getProfiles();
  const discovery = buildPublicAgentDiscovery([...profiles.values()]);
  return {
    content: [{ type: "text", text: discovery.content }],
    details: {
      jobs: [],
      diagnostics: [],
      operation: "agents",
      profiles: discovery.profiles,
      omittedProfiles: discovery.omittedProfiles,
    },
  };
}

export async function startJobs(input: StartInput, services: ToolServices, ctx: ExtensionContext): Promise<ToolResponse & { details: ToolDetails }> {
  if (input.tasks.length > 8) return response("A start batch accepts at most 8 jobs.", [], ["A start batch accepts at most 8 jobs."], "start");

  const requests = input.tasks.map(toRequest);
  const profiles = await services.getProfiles();
  const unknown = requests.find((request) => !profiles.has(request.agent));
  if (unknown) {
    const diagnostic = formatUnknownProfileDiagnostic(unknown.agent, [...profiles.values()]);
    return response(diagnostic, [], [diagnostic], "start");
  }
  const writable = requests.filter((request) => request.writeAccess);
  if (writable.length > 0) {
    const confirmation = await services.confirmWritable(writable, ctx);
    if (confirmation !== "approved") {
      const diagnostic = confirmation === "declined"
        ? "Writable jobs were declined."
        : "Writable confirmation requires interactive UI.";
      return response(diagnostic, [], [diagnostic], "start");
    }
  }

  const jobs = services.manager.enqueue(requests, profiles, services.defaults(ctx));
  return response(`Started ${jobs.length} job${jobs.length === 1 ? "" : "s"}: ${summary(jobs)}.`, jobs, [], "start");
}

export async function statusJobs(input: StatusInput, services: ToolServices): Promise<ToolResponse & { details: ToolDetails }> {
  if (input.id) {
    const job = services.manager.get(input.id);
    if (!job) return response(`Unknown job: ${input.id}`, [], [`Unknown job: ${input.id}`], "status");
    return response(`${job.id}: ${job.state}`, [job], [], "status");
  }

  const jobs = services.manager.list();
  return response(jobs.length === 0 ? "No background subagent jobs." : `Jobs: ${summary(jobs)}`, jobs, [], "status");
}

const waitSummary = (jobs: readonly WaitJobStatus[]): string =>
  jobs.map((job) => `${job.id} (${job.state})`).join(", ");

const expectedWaitDiagnostic = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  return /^(Unknown job|Duplicate job ID): /.test(error.message) ? error.message : undefined;
};

export async function waitJobs(
  input: WaitInput,
  services: ToolServices,
  signal?: AbortSignal,
): Promise<ToolResponse> {
  const until: WaitUntil = input.until ?? "all";
  const timeoutMs = input.timeoutMs ?? 60_000;
  let result: WaitResult;
  try {
    result = await services.manager.waitFor({ ids: input.ids, until, timeoutMs, signal });
  } catch (error) {
    const diagnostic = expectedWaitDiagnostic(error);
    if (!diagnostic) throw error;
    return response(diagnostic, [], [diagnostic], "wait");
  }

  const jobs = waitSummary(result.jobs);
  const content = result.outcome === "completed"
    ? `Wait completed: ${jobs}.`
    : result.outcome === "timed_out"
      ? `Wait timed out after ${timeoutMs} ms: ${jobs}.\nDo not wait again immediately; continue other work or return control.`
      : `Wait aborted: ${jobs}.`;
  return { content: [{ type: "text", text: content }], details: result };
}

export async function controlJobs(input: ControlInput, services: ToolServices): Promise<ToolResponse & { details: ToolDetails }> {
  const jobs: Job[] = [];
  const diagnostics: string[] = [];
  const collected: Job[] = [];

  for (const id of input.ids) {
    const job = services.manager.get(id);
    if (!job) {
      diagnostics.push(`Unknown job: ${id}`);
      continue;
    }
    if (input.action === "cancel" && !["queued", "running", "cancelled"].includes(job.state)) {
      diagnostics.push(`Cannot cancel job in ${job.state} state`);
      continue;
    }
    if (input.action === "collect" && !["completed", "failed", "cancelled", "collected"].includes(job.state)) {
      diagnostics.push(`Cannot collect job in ${job.state} state`);
      continue;
    }
    if (input.action === "discard" && !["completed", "failed", "cancelled", "discarded"].includes(job.state)) {
      diagnostics.push(`Cannot discard job in ${job.state} state`);
      continue;
    }

    if (input.action === "cancel") jobs.push(await services.manager.cancel(id));
    else if (input.action === "discard") jobs.push(services.manager.discard(id));
    else collected.push(job);
  }

  if (input.action === "collect" && collected.length > 0) {
    const content = capCollectedPayload(collected.map(formatCollectedResult).join("\n\n---\n\n"));
    jobs.push(...collected.map((job) => services.manager.collect(job.id)));
    return response(content, jobs, diagnostics, "collect");
  }
  const action = input.action === "discard" ? "Discarded" : "Cancelled";
  const compact = jobs.length > 0 ? `${action}: ${summary(jobs)}.` : "No jobs changed.";
  return response(diagnostics.length > 0 ? `${compact} ${diagnostics.join(" ")}` : compact, jobs, diagnostics, input.action);
}

const description = [
  "Start self-contained background tasks.",
  "Jobs are read-only unless writes are needed.",
  "Only collected output enters context.",
  "Each job's collected result is capped at 50 KiB, and batched collection shares a 50 KiB aggregate cap.",
  "Request concise output, split broad investigations, and collect large results individually.",
  "Concurrent writable jobs should receive non-overlapping work.",
].join(" ");

const iconForState = (state: Job["state"]): string => {
  if (state === "completed") return "✓";
  if (state === "failed" || state === "cancelled") return "✗";
  if (state === "collected") return "↳";
  if (state === "discarded") return "⌫";
  return state === "queued" ? "○" : "…";
};

const renderWaitResult = (
  result: ToolResponse,
  expanded: boolean,
  theme: { fg(color: string, text: string): string },
): string => {
  if (!("outcome" in result.details)) return "";
  const { outcome, jobs, until, timeoutMs, elapsedMs } = result.details;
  const label = outcome === "completed" ? "Wait completed" : outcome === "timed_out" ? "Wait timed out" : "Wait aborted";
  const compact = [label, ...jobs.map((job) => `${iconForState(job.state)} ${job.id} ${job.state}`)].join("\n");
  const detail = expanded
    ? `Condition: ${until}\nConfigured timeout: ${timeoutMs} ms\nElapsed: ${elapsedMs} ms`
    : "";
  return theme.fg("muted", [compact, detail].filter(Boolean).join("\n\n"));
};

const renderAgentProfiles = (
  result: AgentsToolResponse,
  expanded: boolean,
  theme: { fg(color: string, text: string): string },
): string => {
  const profiles = result.details.profiles ?? [];
  const omitted = result.details.omittedProfiles ?? 0;
  const compact = [
    "Available subagent profiles:",
    ...profiles.map((profile) => `- ${profile.name} — ${profile.description}`),
    ...(omitted > 0 ? [`- ${omitted} additional profile${omitted === 1 ? "" : "s"} omitted`] : []),
  ].join("\n");
  if (!expanded) return theme.fg("muted", compact);

  const detail = profiles.map((profile) => [
    `${profile.name} — ${profile.description}`,
    `  Model: ${profile.model ?? "parent model (inherited)"}`,
    `  Read-only launch allowlist: ${profile.readOnlyToolAllowlist.join(", ") || "none"}`,
    `  Writable launch allowlist: ${profile.writableToolAllowlist.join(", ") || "none"}`,
    `  Supports write-capable tools: ${profile.supportsWrite ? "yes" : "no"}`,
  ].join("\n")).join("\n\n");
  return theme.fg("muted", [compact, detail].filter(Boolean).join("\n\n"));
};

const launchThinking = (job: Job): string => {
  if (job.launchThinkingLevel) {
    const source = job.launchThinkingSource === "job" ? "job override"
      : job.launchThinkingSource === "parent" ? "parent session"
        : "legacy profile/parent behavior";
    return `${job.launchThinkingLevel} (${source})`;
  }
  return job.launchThinkingSource === "legacy" ? "legacy profile/parent behavior" : "model or Pi default";
};

const launchDetail = (job: Job): string => [
  `  ${job.request.task}`,
  `  Launch model: ${job.launchModel ?? "Pi default"}`,
  `  Launch thinking: ${launchThinking(job)}`,
].join("\n");

const renderToolResult = (result: ToolResponse, expanded: boolean, theme: { fg(color: string, text: string): string }): string => {
  if ("outcome" in result.details) return renderWaitResult(result, expanded, theme);
  const { jobs, diagnostics, operation } = result.details;
  const content = result.content.find((part) => part.type === "text")?.text ?? "";
  const heading = jobs.length === 0 ? "" : operation === "start" ? `Started ${jobs.length} job${jobs.length === 1 ? "" : "s"}`
    : operation === "collect" ? `Collected ${jobs.length} result${jobs.length === 1 ? "" : "s"}`
      : operation === "discard" ? `Discarded ${jobs.length} job${jobs.length === 1 ? "" : "s"}`
        : operation === "cancel" ? `Cancelled ${jobs.length} job${jobs.length === 1 ? "" : "s"}`
          : `Jobs: ${jobs.length}`;
  const compact = [heading, ...jobs.map((job) => `${iconForState(job.state)} ${job.id} ${job.state}`), ...diagnostics].filter(Boolean).join("\n") || content;
  if (!expanded) return theme.fg("muted", compact);

  const detail = operation === "collect" || diagnostics.length > 0 ? content
    : operation === "start" || operation === "status" ? jobs.map(launchDetail).join("\n")
      : "";
  return theme.fg("muted", [compact, detail].filter(Boolean).join("\n\n"));
};

export function registerSubagentTools(pi: ExtensionAPI, services: ToolServices): void {
  pi.registerTool({
    name: "subagent_agents",
    label: "Subagent Profiles",
    description: "List available subagent profile names and safe public capabilities. Call only when profile names or capabilities are unknown, not before every job. Launch allowlists are requested child Pi tools, not write authorization or a runtime sandbox.",
    parameters: AgentsParams,
    execute: async () => listAgents(services),
    renderCall: (_input, theme) => new Text(theme.fg("toolTitle", "subagent_agents"), 0, 0),
    renderResult: (result, { expanded }, theme) =>
      new Text(renderAgentProfiles(result as AgentsToolResponse, expanded, theme), 0, 0),
  });
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagents",
    description,
    parameters: StartParams,
    execute: async (_id, input, _signal, _update, ctx) => startJobs(input, services, ctx),
    renderCall: (input, theme) => new Text(theme.fg("toolTitle", `subagent_start ${input.tasks.length} job${input.tasks.length === 1 ? "" : "s"}`), 0, 0),
    renderResult: (result, { expanded }, theme) => new Text(renderToolResult(result as ToolResponse & { details: ToolDetails }, expanded, theme), 0, 0),
  });
  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: `List background subagent jobs or inspect one job. ${description}`,
    parameters: StatusParams,
    execute: async (_id, input) => statusJobs(input, services),
    renderCall: (input, theme) => new Text(theme.fg("toolTitle", input.id ? `subagent_status ${input.id}` : "subagent_status"), 0, 0),
    renderResult: (result, { expanded }, theme) => new Text(renderToolResult(result as ToolResponse & { details: ToolDetails }, expanded, theme), 0, 0),
  });
  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: [
      "Wait once for requested jobs only when they are expected to finish soon and no useful parent work can proceed meanwhile.",
      "The wait lasts at most 5 minutes, returns as soon as the requested condition is satisfied, and never collects output or cancels jobs.",
      "After a timeout, do not call subagent_wait again immediately; continue other work or return control.",
    ].join(" "),
    parameters: WaitParams,
    execute: async (_id, input, signal) => waitJobs(input, services, signal),
    renderCall: (input, theme) => new Text(
      theme.fg("toolTitle", `subagent_wait ${input.until ?? "all"} ${input.ids.join(", ")}`),
      0,
      0,
    ),
    renderResult: (result, { expanded }, theme) => new Text(
      renderToolResult(result as ToolResponse, expanded, theme),
      0,
      0,
    ),
  });
  pi.registerTool({
    name: "subagent_control",
    label: "Control Subagents",
    description: `Cancel, collect, or discard background subagent jobs. ${description}`,
    parameters: ControlParams,
    execute: async (_id, input) => controlJobs(input, services),
    renderCall: (input, theme) => new Text(theme.fg("toolTitle", `subagent_control ${input.action} ${input.ids.join(", ")}`), 0, 0),
    renderResult: (result, { expanded }, theme) => new Text(renderToolResult(result as ToolResponse & { details: ToolDetails }, expanded, theme), 0, 0),
  });
}
