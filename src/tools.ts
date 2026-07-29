import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { JobManager } from "./job-manager.js";
import { formatCollectedResult } from "./output.js";
import type { AgentProfile, Job, JobRequest } from "./types.js";

const StartTask = Type.Object({
  task: Type.String({ minLength: 1 }),
  agent: Type.Optional(Type.String({ default: "generic" })),
  writeAccess: Type.Optional(Type.Boolean({ default: false })),
  cwd: Type.Optional(Type.String()),
});

export const StartParams = Type.Object({
  tasks: Type.Array(StartTask, { minItems: 1, maxItems: 8 }),
});
export const StatusParams = Type.Object({ id: Type.Optional(Type.String()) });
export const ControlParams = Type.Object({
  action: StringEnum(["cancel", "collect", "discard"] as const),
  ids: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
});

export type StartInput = Static<typeof StartParams>;
export type StatusInput = Static<typeof StatusParams>;
export type ControlInput = Static<typeof ControlParams>;

export interface ToolServices {
  manager: JobManager;
  getProfiles(): Promise<ReadonlyMap<string, AgentProfile>>;
  confirmWritable(requests: readonly JobRequest[], ctx: ExtensionContext): Promise<boolean>;
  defaults(ctx: ExtensionContext): { cwd: string; parentModel?: string; thinkingLevel?: string };
}

export interface ToolDetails {
  jobs: Job[];
  diagnostics: string[];
  operation?: "start" | "status" | "cancel" | "collect" | "discard";
}

export interface ToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details: ToolDetails;
}

const response = (
  content: string,
  jobs: readonly Job[] = [],
  diagnostics: string[] = [],
  operation?: ToolDetails["operation"],
): ToolResponse => ({
  content: [{ type: "text", text: content }],
  details: { jobs: [...jobs], diagnostics, operation },
});

const toRequest = (task: StartInput["tasks"][number]): JobRequest => ({
  task: task.task,
  agent: task.agent ?? "generic",
  writeAccess: task.writeAccess ?? false,
  cwd: task.cwd,
});

const summary = (jobs: readonly Job[]): string => jobs.map((job) => `${job.id} (${job.state})`).join(", ");

export async function startJobs(input: StartInput, services: ToolServices, ctx: ExtensionContext): Promise<ToolResponse> {
  if (input.tasks.length > 8) return response("A start batch accepts at most 8 jobs.", [], ["A start batch accepts at most 8 jobs."], "start");

  const requests = input.tasks.map(toRequest);
  const profiles = await services.getProfiles();
  const unknown = requests.find((request) => !profiles.has(request.agent));
  if (unknown) {
    const diagnostic = `Unknown agent profile: ${unknown.agent}`;
    return response(diagnostic, [], [diagnostic], "start");
  }
  const writable = requests.filter((request) => request.writeAccess);
  if (writable.length > 0 && !(await services.confirmWritable(writable, ctx))) {
    return response("Writable jobs were not approved.", [], [], "start");
  }

  const jobs = services.manager.enqueue(requests, profiles, services.defaults(ctx));
  return response(`Started ${jobs.length} job${jobs.length === 1 ? "" : "s"}: ${summary(jobs)}.`, jobs, [], "start");
}

export async function statusJobs(input: StatusInput, services: ToolServices): Promise<ToolResponse> {
  if (input.id) {
    const job = services.manager.get(input.id);
    if (!job) return response(`Unknown job: ${input.id}`, [], [`Unknown job: ${input.id}`], "status");
    return response(`${job.id}: ${job.state}`, [job], [], "status");
  }

  const jobs = services.manager.list();
  return response(jobs.length === 0 ? "No background subagent jobs." : `Jobs: ${summary(jobs)}`, jobs, [], "status");
}

export async function controlJobs(input: ControlInput, services: ToolServices): Promise<ToolResponse> {
  const jobs: Job[] = [];
  const diagnostics: string[] = [];
  const collected: string[] = [];

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
    else {
      collected.push(formatCollectedResult(job));
      jobs.push(services.manager.collect(id));
    }
  }

  if (input.action === "collect" && collected.length > 0) return response(collected.join("\n\n---\n\n"), jobs, diagnostics, "collect");
  const action = input.action === "discard" ? "Discarded" : "Cancelled";
  const compact = jobs.length > 0 ? `${action}: ${summary(jobs)}.` : "No jobs changed.";
  return response(diagnostics.length > 0 ? `${compact} ${diagnostics.join(" ")}` : compact, jobs, diagnostics, input.action);
}

const description = [
  "Start self-contained background tasks.",
  "Jobs are read-only unless writes are needed.",
  "Only collected output enters context.",
  "Concurrent writable jobs should receive non-overlapping work.",
].join(" ");

const renderToolResult = (result: ToolResponse, expanded: boolean, theme: { fg(color: string, text: string): string }): string => {
  const { jobs, diagnostics, operation } = result.details;
  const content = result.content.find((part) => part.type === "text")?.text ?? "";
  const icon = (state: Job["state"]): string => {
    if (state === "completed") return "✓";
    if (state === "failed" || state === "cancelled") return "✗";
    if (state === "collected") return "↳";
    if (state === "discarded") return "⌫";
    return state === "queued" ? "○" : "…";
  };
  const heading = jobs.length === 0 ? "" : operation === "start" ? `Started ${jobs.length} job${jobs.length === 1 ? "" : "s"}`
    : operation === "collect" ? `Collected ${jobs.length} result${jobs.length === 1 ? "" : "s"}`
      : operation === "discard" ? `Discarded ${jobs.length} job${jobs.length === 1 ? "" : "s"}`
        : operation === "cancel" ? `Cancelled ${jobs.length} job${jobs.length === 1 ? "" : "s"}`
          : `Jobs: ${jobs.length}`;
  const compact = [heading, ...jobs.map((job) => `${icon(job.state)} ${job.id} ${job.state}`), ...diagnostics].filter(Boolean).join("\n") || content;
  if (!expanded) return theme.fg("muted", compact);

  const detail = operation === "collect" || diagnostics.length > 0 ? content
    : operation === "start" || operation === "status" ? jobs.map((job) => `  ${job.request.task}`).join("\n")
      : "";
  return theme.fg("muted", [compact, detail].filter(Boolean).join("\n\n"));
};

export function registerSubagentTools(pi: ExtensionAPI, services: ToolServices): void {
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagents",
    description,
    parameters: StartParams,
    execute: async (_id, input, _signal, _update, ctx) => startJobs(input, services, ctx),
    renderCall: (input, theme) => new Text(theme.fg("toolTitle", `subagent_start ${input.tasks.length} job${input.tasks.length === 1 ? "" : "s"}`), 0, 0),
    renderResult: (result, { expanded }, theme) => new Text(renderToolResult(result as ToolResponse, expanded, theme), 0, 0),
  });
  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: `List background subagent jobs or inspect one job. ${description}`,
    parameters: StatusParams,
    execute: async (_id, input) => statusJobs(input, services),
    renderCall: (input, theme) => new Text(theme.fg("toolTitle", input.id ? `subagent_status ${input.id}` : "subagent_status"), 0, 0),
    renderResult: (result, { expanded }, theme) => new Text(renderToolResult(result as ToolResponse, expanded, theme), 0, 0),
  });
  pi.registerTool({
    name: "subagent_control",
    label: "Control Subagents",
    description: `Cancel, collect, or discard background subagent jobs. ${description}`,
    parameters: ControlParams,
    execute: async (_id, input) => controlJobs(input, services),
    renderCall: (input, theme) => new Text(theme.fg("toolTitle", `subagent_control ${input.action} ${input.ids.join(", ")}`), 0, 0),
    renderResult: (result, { expanded }, theme) => new Text(renderToolResult(result as ToolResponse, expanded, theme), 0, 0),
  });
}
