import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { registerSubagentsUi } from "./dashboard.js";
import { discoverDefaultAgents, type DiscoverAgentsResult } from "./agents.js";
import { loadConfig, type LoadConfigResult } from "./config.js";
import { JobManager } from "./job-manager.js";
import { PiProcessRunner } from "./process-runner.js";
import { registerSubagentTools, type ToolServices } from "./tools.js";
import type { Job, JobRequest } from "./types.js";

export interface ExtensionDependencies {
  createManager?: () => JobManager;
  loadConfig?: (path: string) => Promise<LoadConfigResult>;
  discoverProfiles?: () => Promise<DiscoverAgentsResult>;
  getAgentDir?: () => string;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface TimerDependencies {
  setTimer(callback: () => void, delay: number): unknown;
  clearTimer(timer: unknown): void;
}

const terminal = new Set<Job["state"]>(["completed", "failed", "cancelled"]);

export function installCompletionNotifier(pi: ExtensionAPI, manager: JobManager, timers: TimerDependencies = {
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
}): () => void {
  const previous = new Map<string, Job["state"]>();
  const pending = new Map<string, Job["state"]>();
  const notified = new Set<string>();
  let initialized = false;
  let timer: unknown;

  const flush = () => {
    timer = undefined;
    const ready = [...pending.entries()];
    pending.clear();
    if (ready.length === 0) return;
    const jobIds = ready.map(([id]) => id);
    const summary = `Ready jobs: ${ready.map(([id, state]) => `${id} (${state})`).join(", ")}.`;
    pi.sendMessage({
      customType: "simple-subagents-ready",
      content: `${summary}\nAsk the user whether and when they want to collect these results.`,
      display: true,
      details: { jobIds },
    }, { deliverAs: "followUp", triggerTurn: true });
  };

  const unsubscribe = manager.subscribe((jobs) => {
    if (!initialized) {
      for (const job of jobs) previous.set(job.id, job.state);
      initialized = true;
      return;
    }
    for (const job of jobs) {
      const was = previous.get(job.id);
      previous.set(job.id, job.state);
      if (terminal.has(job.state) && !terminal.has(was ?? "queued") && !notified.has(job.id)) {
        notified.add(job.id);
        pending.set(job.id, job.state);
      }
    }
    if (pending.size > 0 && timer === undefined) timer = timers.setTimer(flush, 100);
  });

  return () => {
    unsubscribe();
    if (timer !== undefined) timers.clearTimer(timer);
    timer = undefined;
    pending.clear();
  };
}

export function createSimpleSubagentsExtension(dependencies: ExtensionDependencies = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const manager = dependencies.createManager?.() ?? new JobManager({ runner: new PiProcessRunner() });
    const readConfig = dependencies.loadConfig ?? loadConfig;
    const discoverProfiles = dependencies.discoverProfiles ?? discoverDefaultAgents;
    const resolveAgentDir = dependencies.getAgentDir ?? getAgentDir;
    const timers: TimerDependencies = {
      setTimer: dependencies.setTimer ?? ((callback, delay) => setTimeout(callback, delay)),
      clearTimer: dependencies.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout)),
    };
    let config = { confirmWrites: false };
    let profiles = new Map<string, Job["profile"]>();
    let removeNotifier: (() => void) | undefined;
    let shutdown: Promise<void> | undefined;

    const services: ToolServices = {
      manager,
      getProfiles: async () => profiles,
      confirmWritable: async (requests: readonly JobRequest[], ctx: ExtensionContext) => {
        if (!config.confirmWrites || requests.length === 0) return true;
        if (!ctx.hasUI) return false;
        return ctx.ui.confirm(
          "Allow writable subagents?",
          `Allow ${requests.length} writable background job${requests.length === 1 ? "" : "s"}? Their work should not overlap.`,
        );
      },
      defaults: (ctx) => ({
        cwd: ctx.cwd,
        parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      }),
    };

    registerSubagentTools(pi, services);
    const removeSubagentsUi = registerSubagentsUi(pi, manager);
    pi.registerMessageRenderer("simple-subagents-ready", (message, { expanded, outputPad }, theme) => {
      const details = message.details as { jobIds?: string[] } | undefined;
      const ids = details?.jobIds?.join(", ") ?? "";
      const detail = expanded && ids ? `\n${theme.fg("dim", ids)}` : "";
      const content = typeof message.content === "string" ? message.content : "Subagent jobs are ready.";
      return new Text(theme.fg("accent", content) + detail, outputPad, 0);
    });

    pi.on("session_start", async (_event, ctx) => {
      const [loadedConfig, discovered] = await Promise.all([
        readConfig(join(resolveAgentDir(), "simple-subagents.json")),
        discoverProfiles(),
      ]);
      config = loadedConfig.config;
      profiles = new Map(discovered.agents.map((profile) => [profile.name, profile]));
      if (loadedConfig.warning) ctx.ui.notify(loadedConfig.warning, "warning");
      for (const diagnostic of discovered.diagnostics) ctx.ui.notify(diagnostic, "warning");
      removeNotifier?.();
      removeNotifier = installCompletionNotifier(pi, manager, timers);
    });

    pi.on("session_shutdown", async () => {
      removeNotifier?.();
      removeNotifier = undefined;
      removeSubagentsUi();
      shutdown ??= manager.shutdown();
      await shutdown;
    });
  };
}

export default createSimpleSubagentsExtension();
