# Child Extension Isolation Design

## Goal

Make subagent jobs close reliably after Pi finishes the agent by disabling extension discovery in every child Pi process.

## Root Cause

`simple-subagents` currently launches child Pi with `--mode json`, `-p`, and `--no-session`, but without `--no-extensions`. Child processes therefore load the same global and project-local extensions as the parent session.

Pi emits `turn_end` and then `agent_end` before print-mode shutdown. During shutdown, loaded extensions can start or retain background work. In the observed failure, child `pi-lens` ran quiet-window analysis after the agent settled. That work kept the operating-system process alive after the model had finished. `simple-subagents` correctly waits for the child process `close` event before settling a job, so the job remained running with `Model turn finished` as its latest activity.

A controlled disposable edit task confirmed the boundary:

- With extension discovery enabled, Pi emitted `agent_end` but remained alive until the 30-second probe limit terminated it.
- With `--no-extensions`, the same task emitted `agent_end` and closed normally.

Child extension loading also explains the unrelated formatter rewrites observed after subagent work: child `pi-lens` continued analysis against the shared workspace.

## Selected Approach

Every child Pi launch includes `--no-extensions` as a fixed argument.

This is mandatory isolation, not a parent-controlled or profile-controlled option. The main agent cannot remove it, and agent profile frontmatter cannot opt back into extension discovery.

The parent Pi session is unchanged and keeps its configured extensions.

## Child Runtime Boundary

With this change, child processes retain:

- The selected model and thinking configuration.
- The selected agent profile and appended system prompt.
- Project instructions.
- Skills and prompt templates discovered by Pi.
- Built-in tools allowed by the existing read-only or writable profile policy.

Child processes do not load:

- Global npm or Git Pi extensions.
- User extensions under the Pi agent directory.
- Project-local extensions under the child working directory.
- `pi-lens`, `pi-web-access`, `pi-mcp-adapter`, nested `simple-subagents`, or extension-provided UI and lifecycle hooks.

Research that needs web access must be prepared by the parent before the child starts. For example, the parent can fetch or clone sources and ask a read-only child to analyze the local copies.

## Process Lifecycle

The completion contract remains process-based:

1. Child Pi emits model, tool, turn, and agent events.
2. `simple-subagents` captures bounded output and activity.
3. Child Pi finishes normal print-mode cleanup and exits.
4. The process `close` event settles the runner result and the job becomes completed or failed.

`turn_end` remains activity only. It must not settle the job because a Pi agent can have multiple turns. This change does not add an `agent_end` shortcut, forced termination, or a post-completion timeout.

## Launch Construction

`PiProcessRunner` adds one `--no-extensions` argument to the fixed argument prefix used for every child invocation. Model, thinking, tool, access, working-directory, prompt-file, cancellation, and result behavior remain unchanged.

No explicit `--extension` or `-e` arguments are added. Pi documents that explicit extension paths can still load when `--no-extensions` is present, so prohibiting explicit extension arguments is part of the isolation boundary.

## Error Handling

The package supports Pi versions that provide `--no-extensions`. If a child Pi installation unexpectedly rejects the flag, the child exits with an error and the existing process-result path marks the job failed. The runner does not retry without isolation.

No new configuration errors or profile discovery errors are introduced.

## Tests

Focused automated tests verify:

1. The fixed child argument prefix contains exactly one `--no-extensions`.
2. Generic, named-profile, model, thinking, read-only, and writable launch paths retain the flag.
3. Child launches contain no explicit `--extension` or `-e` argument.
4. Existing cancellation, output capture, and result settlement behavior remains unchanged.
5. README documentation states that child extensions and extension-provided tools are unavailable.

A manual disposable real-Pi edit probe verifies that a child reaches `agent_end` and closes normally without child `pi-lens` quiet-window work.

## Evidence About Lost Functionality

A review of recent records found no useful child `pi-lens`, MCP, nested-subagent, or UI-extension calls. Ninety-six deduplicated current `simple-subagents` jobs showed only built-in tool activity in retained status records.

One of eighteen older full child-session records used extension-provided web tools for repository research: one `web_search` call and three `fetch_content` calls. Full isolation deliberately removes that direct child capability. The parent-prepares-sources workflow preserves the overall research use case without allowing child extension lifecycle work.

Current `--no-session` child runs do not retain full transcripts, so bounded status evidence cannot prove that no unrecorded extension tool was ever called. This limitation does not change the selected mandatory isolation policy.

## Documentation

README launch and capability text is updated to state:

- Child Pi runs with extension discovery disabled.
- Profile tool lists apply to built-in tools only in this runtime.
- Extension-provided tools are unavailable to children.
- The parent should prepare local sources for research jobs that would otherwise need web extensions.

## Non-Goals

This change does not:

- Change thinking-level selection or agent profile format.
- Add job execution deadlines.
- Complete jobs on `turn_end` or `agent_end`.
- Change cancellation escalation.
- Disable skills, prompt templates, project instructions, or parent-session extensions.
- Add a child-extension allowlist or per-profile escape hatch.
