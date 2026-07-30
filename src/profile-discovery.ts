import { truncateUtf8 } from "./output.js";
import { getLaunchToolAllowlist } from "./profile-capabilities.js";
import type { AgentProfile } from "./types.js";

export interface PublicAgentProfile {
  name: string;
  description: string;
  source: "builtin" | "user";
  model: string | null;
  inheritsParentModel: boolean;
  readOnlyToolAllowlist: string[];
  writableToolAllowlist: string[];
  supportsWrite: boolean;
}

export function sanitizePublicText(value: string, maxBytes: number): string {
  const normalized = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return truncateUtf8(normalized, maxBytes).text.trim();
}

export function toPublicAgentProfile(profile: AgentProfile): PublicAgentProfile {
  const readOnlyToolAllowlist = getLaunchToolAllowlist(profile, "read-only")
    .map((tool) => sanitizePublicText(tool, 128));
  const writableToolAllowlist = getLaunchToolAllowlist(profile, "write")
    .map((tool) => sanitizePublicText(tool, 128));
  const model = profile.model ? sanitizePublicText(profile.model, 512) : null;

  return {
    name: sanitizePublicText(profile.name, 128),
    description: sanitizePublicText(profile.description, 512),
    source: profile.source,
    model,
    inheritsParentModel: model === null,
    readOnlyToolAllowlist,
    writableToolAllowlist,
    supportsWrite: writableToolAllowlist.some((tool) => tool === "bash" || tool === "edit" || tool === "write"),
  };
}
