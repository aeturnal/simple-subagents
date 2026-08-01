import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
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
}

export function createSimpleSubagentsExtension(dependencies: ExtensionDependencies = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const manager = dependencies.createManager?.() ?? new JobManager({ runner: new PiProcessRunner() });
    const readConfig = dependencies.loadConfig ?? loadConfig;
    const discoverProfiles = dependencies.discoverProfiles ?? discoverDefaultAgents;
    const resolveAgentDir = dependencies.getAgentDir ?? getAgentDir;
    let config = { confirmWrites: false };
    let profiles = new Map<string, Job["profile"]>();
    let shutdown: Promise<void> | undefined;

    const services: ToolServices = {
      manager,
      getProfiles: async () => profiles,
      confirmWritable: async (requests: readonly JobRequest[], ctx: ExtensionContext) => {
        if (!config.confirmWrites || requests.length === 0) return "approved";
        if (!ctx.hasUI) return "unavailable";
        return (await ctx.ui.confirm(
          "Allow writable subagents?",
          `Allow ${requests.length} writable background job${requests.length === 1 ? "" : "s"}? Their work should not overlap.`,
        )) ? "approved" : "declined";
      },
      defaults: (ctx) => ({
        cwd: ctx.cwd,
        parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      }),
    };

    registerSubagentTools(pi, services);
    const removeSubagentsUi = registerSubagentsUi(pi, manager);

    pi.on("session_start", async (_event, ctx) => {
      const [loadedConfig, discovered] = await Promise.all([
        readConfig(join(resolveAgentDir(), "simple-subagents.json")),
        discoverProfiles(),
      ]);
      config = loadedConfig.config;
      profiles = new Map(discovered.agents.map((profile) => [profile.name, profile]));
      if (loadedConfig.warning) ctx.ui.notify(loadedConfig.warning, "warning");
      for (const diagnostic of discovered.diagnostics) ctx.ui.notify(diagnostic, "warning");
    });

    pi.on("session_shutdown", async () => {
      removeSubagentsUi();
      shutdown ??= manager.shutdown();
      await shutdown;
    });
  };
}

export default createSimpleSubagentsExtension();
