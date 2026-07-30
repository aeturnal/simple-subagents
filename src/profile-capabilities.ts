import type { AccessMode, AgentProfile } from "./types.js";

const READ_ONLY_TOOL_ORDER = ["read", "grep", "find", "ls"] as const;
const WRITABLE_TOOL_ORDER = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;

export function getLaunchToolAllowlist(profile: AgentProfile, accessMode: AccessMode): string[] {
  const permitted = accessMode === "write" ? WRITABLE_TOOL_ORDER : READ_ONLY_TOOL_ORDER;
  if (profile.name === "generic") return [...permitted];

  const requested = new Set(profile.tools ?? []);
  return permitted.filter((tool) => requested.has(tool));
}
