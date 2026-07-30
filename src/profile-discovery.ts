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

export const PUBLIC_DISCOVERY_MAX_BYTES = 50 * 1024;

export interface PublicAgentDiscovery {
  profiles: PublicAgentProfile[];
  omittedProfiles: number;
  content: string;
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

const list = (tools: readonly string[]): string => tools.length === 0 ? "none" : tools.join(", ");

const formatPublicProfile = (profile: PublicAgentProfile): string => [
  `- ${profile.name} — ${profile.description}`,
  `  Source: ${profile.source}`,
  `  Configured model: ${profile.model ?? "none"}`,
  `  Inherits parent model: ${profile.inheritsParentModel ? "yes" : "no"}`,
  `  Read-only launch allowlist: ${list(profile.readOnlyToolAllowlist)}`,
  `  Writable launch allowlist: ${list(profile.writableToolAllowlist)}`,
  `  Supports write-capable tools: ${profile.supportsWrite ? "yes" : "no"}`,
].join("\n");

const omissionNotice = (count: number): string =>
  `Omitted ${count} profile${count === 1 ? "" : "s"} because discovery output is limited to 50 KiB.`;

const formatContent = (profiles: readonly PublicAgentProfile[], omittedProfiles: number): string => [
  "Available subagent profiles:",
  ...profiles.map(formatPublicProfile),
  ...(omittedProfiles > 0 ? [omissionNotice(omittedProfiles)] : []),
].join("\n");

export function buildPublicAgentDiscovery(privateProfiles: readonly AgentProfile[]): PublicAgentDiscovery {
  const mapped = privateProfiles.map(toPublicAgentProfile);
  const profiles: PublicAgentProfile[] = [];

  for (const candidate of mapped) {
    const next = [...profiles, candidate];
    const omittedProfiles = mapped.length - next.length;
    const content = formatContent(next, omittedProfiles);
    const details = JSON.stringify({
      jobs: [],
      diagnostics: [],
      operation: "agents",
      profiles: next,
      omittedProfiles,
    });

    if (Buffer.byteLength(content, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES
      || Buffer.byteLength(details, "utf8") > PUBLIC_DISCOVERY_MAX_BYTES) break;
    profiles.push(candidate);
  }

  const omittedProfiles = mapped.length - profiles.length;
  return { profiles, omittedProfiles, content: formatContent(profiles, omittedProfiles) };
}
