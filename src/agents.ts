import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "./types.js";

export interface DiscoverAgentsResult {
  agents: AgentProfile[];
  diagnostics: string[];
}

const GENERIC_AGENT: AgentProfile = {
  name: "generic",
  description: "Generic coding agent",
  systemPrompt: "You are a helpful coding agent.",
  source: "builtin",
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseTools(value: unknown): string[] | undefined {
  const text = asTrimmedString(value);
  if (!text) {
    return undefined;
  }

  const tools = text
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  return tools.length > 0 ? tools : undefined;
}

function isSupportedProfile(frontmatter: Record<string, unknown>): boolean {
  const source = asTrimmedString(frontmatter.source);
  return source !== "project";
}

function createAgent(filePath: string, frontmatter: Record<string, unknown>, body: string): AgentProfile | undefined {
  const name = asTrimmedString(frontmatter.name);
  const description = asTrimmedString(frontmatter.description);

  if (!name || !description) {
    return undefined;
  }

  if (!isSupportedProfile(frontmatter)) {
    return undefined;
  }

  const model = asTrimmedString(frontmatter.model);
  const tools = parseTools(frontmatter.tools);

  return {
    name,
    description,
    systemPrompt: body.trim(),
    tools,
    model: model || undefined,
    source: "user",
    filePath,
  };
}

export async function discoverAgents(agentsDir: string): Promise<DiscoverAgentsResult> {
  const diagnostics: string[] = [];
  const agents = [GENERIC_AGENT];
  const seen = new Set([GENERIC_AGENT.name]);

  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { agents, diagnostics };
    }

    diagnostics.push(
      `Failed to read agent directory ${agentsDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { agents, diagnostics };
  }

  const mdEntries = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of mdEntries) {
    const filePath = join(agentsDir, entry.name);

    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      diagnostics.push(`Skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content));
    } catch (error) {
      diagnostics.push(
        `Failed to parse frontmatter in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const agent = createAgent(filePath, frontmatter, body);

    if (!agent) {
      if (isSupportedProfile(frontmatter)) {
        diagnostics.push(`Skipped ${filePath}: missing name or description`);
      } else {
        diagnostics.push(`Skipped ${filePath}: project profiles are excluded`);
      }
      continue;
    }

    if (seen.has(agent.name)) {
      diagnostics.push(`Skipped duplicate agent ${agent.name} in ${filePath}`);
      continue;
    }

    seen.add(agent.name);
    agents.push(agent);
  }

  return { agents, diagnostics };
}

export const discoverDefaultAgents = (): Promise<DiscoverAgentsResult> => discoverAgents(join(getAgentDir(), "agents"));
