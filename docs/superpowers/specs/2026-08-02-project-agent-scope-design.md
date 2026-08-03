# Project Agent Scope Design

## Purpose

Add a suggestion to `suggestion-box.md` for project-scoped subagent profiles. The future feature should follow the profile discovery behavior of Pi's bundled subagent example while preserving `simple-subagents`' background-job model.

The Markdown profile schema does not need to change. Both implementations already use YAML frontmatter with `name`, `description`, optional `tools`, and optional `model`, followed by the agent's system prompt.

## Scope interface

Add an optional top-level `agentScope` field to `subagent_agents` and `subagent_start`:

```json
{
  "agentScope": "both"
}
```

```json
{
  "agentScope": "both",
  "tasks": [{ "agent": "reviewer", "task": "Review the change" }]
}
```

Supported values are `user`, `project`, and `both`. The default remains `user` for backward compatibility. One scope applies to the complete tool call; individual tasks cannot select different scopes.

Scope resolution uses the parent session's working directory. A task's optional `cwd` does not change which profile directory is discovered.

## Profile discovery

Use one shared discovery interface for listing and starting agents.

- `user` loads profiles from `~/.pi/agent/agents/*.md`.
- `project` finds the nearest `.pi/agents/` directory by walking upward from the parent working directory.
- `both` loads both sources.
- Every profile records a source of `builtin`, `user`, or `project`.
- The built-in `generic` profile is always available, appears first, and cannot be replaced.
- In `both`, a project profile replaces a user profile with the same name.
- Duplicate names within one source keep the first profile in alphabetical file order and produce a diagnostic.
- Missing profile directories are not errors.
- Invalid files are skipped and reported through bounded diagnostics.

Project-over-user replacement is intentional and does not produce a duplicate diagnostic.

## Public discovery behavior

`subagent_agents` accepts `agentScope` and labels each returned profile with its source. It may return safe public fields such as name, description, model inheritance, and tool allowlists, but it must not return profile prompts, file paths, or raw frontmatter.

Unknown-agent errors identify the scope that was searched.

## Project prompt confirmation

Project profiles are repository-controlled prompts. Before `subagent_start` launches any profile resolved from the project source, it asks for one interactive confirmation covering all selected project profiles in that batch.

- A batch containing only built-in or user profiles needs no project confirmation.
- In `both`, confirmation depends on the source selected after conflict resolution.
- Declining confirmation starts no jobs from the batch.
- If confirmation is required but interactive UI is unavailable, the complete launch is rejected.
- Existing writable-job confirmation remains separate.

Add `confirmProjectAgents` to `~/.pi/agent/simple-subagents.json`. It defaults to `true`. A user may set it to `false` for trusted non-interactive automation. This is a user-controlled configuration setting, not a tool-call parameter that an agent can disable.

## Compatibility and boundaries

This feature changes profile discovery only. It does not replace the existing background tools or add Pi example-style synchronous single and chain modes. Existing calls without `agentScope` continue to discover user profiles only.

The suggestion should describe alignment with **Pi's bundled subagent example**, not an official Pi subagent standard. Pi core does not define a standard subagent profile format.

## Test expectations for future implementation

Future implementation should cover:

- `user`, `project`, and `both` independently;
- default `user` behavior;
- nearest project directory discovery;
- project-over-user precedence;
- the reserved built-in `generic` profile;
- duplicates and malformed files;
- missing directories;
- source labels without prompt or path exposure;
- unknown-agent diagnostics that include scope;
- confirmation approval, rejection, and unavailable UI;
- the user configuration bypass; and
- mixed batches containing user and project profiles.
