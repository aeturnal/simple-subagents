# 03 — Subagent Profile Discovery Design

## Summary

Add a read-only `subagent_agents` tool that lists available subagent profiles and their safe public capabilities. The parent can choose a valid profile without guessing names or reading user configuration files. System prompts, local paths, credentials, and private diagnostics remain hidden.

This feature is independently releasable. It does not require model overrides and does not alter profile discovery, trust, or job permissions.

## Goals

- List profile names and descriptions available to `subagent_start`.
- Show configured model inheritance and read/write launch allowlists.
- Keep advertised allowlists identical to the tool names passed to child Pi at launch.
- Improve unknown-profile errors by listing valid names.
- Bound discovery output.
- Avoid exposing sensitive profile data.

## Non-goals

- Showing full system prompts.
- Showing profile file paths or raw frontmatter.
- Exposing provider credentials or authentication state.
- Creating, editing, or deleting profiles.
- Enabling project-scoped profiles.
- Validating whether a configured model is currently authenticated.
- Granting write access.

## Public interface

```ts
subagent_agents({})
```

The tool takes an empty object and returns profiles in deterministic discovery order: built-in `generic` first, then accepted user profiles.

Each public entry has this shape:

```ts
interface PublicAgentProfile {
  name: string;
  description: string;
  source: "builtin" | "user";
  model: string | null;
  inheritsParentModel: boolean;
  readOnlyToolAllowlist: string[];
  writableToolAllowlist: string[];
  supportsWrite: boolean;
}
```

`model: null` with `inheritsParentModel: true` means the profile uses the parent model unless a later per-job override feature is present.

`supportsWrite` is true only when the writable launch allowlist contains `bash`, `edit`, or `write`. It describes the requested launch ceiling, not authorization or a runtime sandbox. A job still requires `writeAccess: true`, and write confirmation remains unchanged.

## Launch allowlists

The process runner currently intersects requested profile tools with fixed access-mode allowlists. That calculation will move into a shared pure helper used by both process launch and profile discovery.

For the built-in `generic` profile:

- Read-only tools: `read`, `grep`, `find`, `ls`.
- Writable tools: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`.

For named profiles, each public list is the profile’s requested tools intersected with the corresponding allowlist. A named profile with no tools advertises empty launch lists, matching launch arguments.

Discovery must never claim a tool name that launch would remove. These lists are explicitly labeled **launch allowlists**, not guaranteed effective runtime tools: child Pi may load trusted extensions that alter its active tool set. This feature neither disables child extensions nor claims OS-level enforcement.

## User-visible output

Model-visible tool content always includes every bounded public field needed for selection: names, descriptions, model behavior, launch allowlists, and `supportsWrite`. Compact versus expanded applies only to TUI rendering and never changes what the parent model receives.

Compact TUI output lists profile names and descriptions:

```text
Available subagent profiles:
- generic — Generic coding agent
- reviewer — Review changed code
```

Expanded TUI output renders the model behavior and launch allowlists already present in tool content/details:

```text
reviewer — Review changed code
  Model: anthropic/claude-sonnet-4-5
  Read-only launch allowlist: read, grep
  Writable launch allowlist: read, grep
  Supports write-capable tools: no
```

The tool description tells the parent to call discovery only when profile names or capabilities are unknown, not before every job.

## Sensitive-data boundary

Profile names, descriptions, models, and tools are untrusted user-controlled strings. Public mapping replaces control characters and embedded line breaks with spaces, collapses repeated whitespace, and trims the result before rendering or placing it in diagnostics.

The public view excludes:

- `systemPrompt`.
- `filePath`.
- Raw frontmatter.
- Discovery diagnostics that may contain paths or parser details.
- Provider authentication data.
- Parent system prompts or session context.

Public DTO construction uses an explicit allowlist of fields rather than object spreading, so future private `AgentProfile` fields do not leak automatically.

## Output limits

Model-visible content and public `details.profiles` are built from the same included public records and each remain capped at 50 KiB using UTF-8-safe truncation. Profiles are emitted in deterministic order until the next complete entry would exceed space reserved for the omission notice. The result then reports the number of omitted profiles; omitted records are absent from public details as well.

Sanitized public fields use fixed byte caps: name 128, description 512, and model 512. Tool names are sanitized and capped at 128 bytes, deduplicated, and emitted in fixed allowlist order; the current fixed allowlists bound their count. Internal private profiles remain available to launch even when their public records are omitted.

## Unknown-profile diagnostics

When `subagent_start` receives an unknown profile, it continues rejecting the complete batch before enqueueing. The diagnostic adds a bounded list of available names:

```text
Unknown agent profile: reveiwer. Available profiles: generic, reviewer.
```

Available names use the same sanitization and 128-byte cap as discovery output. The extension does not perform fuzzy matching or silently substitute a profile.

## Architecture

- `agents.ts` continues discovering and validating private `AgentProfile` records.
- A shared helper computes the child Pi tool launch allowlist for an access mode.
- `process-runner.ts` uses that helper when building Pi arguments.
- `tools.ts` maps private profiles to `PublicAgentProfile` records and registers `subagent_agents`.
- Tool details contain only the bounded public records also included in content.

No new configuration, persistence, or runtime dependency is introduced.

## Error handling

- No profiles beyond `generic` is a valid result.
- Invalid profile files remain skipped by existing discovery behavior.
- Duplicate profiles remain first-valid-wins.
- Discovery diagnostics continue going to the existing UI warning path, not the model-facing tool.
- Output truncation reports omissions rather than returning malformed partial entries.

## Testing strategy

Tests cover:

- Built-in generic capabilities.
- Named profile model and tools.
- Parent-model inheritance.
- Profiles with no tools.
- Read-only and writable tool intersection.
- `supportsWrite` calculation.
- Deterministic ordering.
- Existing duplicate and invalid-profile behavior.
- Unknown-profile diagnostics with available names.
- Large profile collections and multibyte truncation.
- Absence of prompts, paths, raw frontmatter, and diagnostics from content and details.
- Compact and expanded rendering.
- Equality between advertised launch allowlists and child Pi `--tools` arguments.
- Sanitization of line breaks, control characters, names used in diagnostics, and oversized user-controlled fields.

## Documentation

The README will document `subagent_agents`, explain capability versus authorization, and state which profile fields remain private.

## Success criteria

- The parent can discover valid profile names without inspecting files.
- Advertised launch allowlists match process-launch arguments without claiming a runtime sandbox.
- No sensitive profile fields enter tool content or details.
- Unknown-profile errors are actionable.
- Existing profile and job behavior remains unchanged.
