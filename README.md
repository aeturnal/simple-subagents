# simple-subagents

Lightweight background Pi subagents. Start independent work in parallel, inspect it while it runs, and collect only the results you need.

Requires Node.js 22.19 or newer and Pi 0.82.x.

## Install

```sh
pi install npm:simple-subagents
```

## Use locally

Install the package persistently, then start Pi normally:

```sh
pi install .
pi
```

Or load the extension for a single run without installing it:

```sh
pi -e ./src/index.ts
```

Ask Pi naturally: “start three parallel subagents to review the tests, dependencies, and docs”; “show subagent status”; “wait for job-1 and job-3”; “cancel job-2”; or “collect job-1 and job-3.” `/subagents` opens the interactive inbox: arrows select, Enter inspects, `c` cancels, `x` collects, `d` discards, and Escape closes.

## Agents and access

The built-in `generic` profile is always available. Add user profiles at `~/.pi/agent/agents/*.md`; project-scoped profiles are intentionally ignored. Profiles use frontmatter followed by the subagent’s system prompt:

```md
---
name: reviewer
description: Review changed code
tools: read, grep
model: anthropic/claude-sonnet-4-5
---
Return concise, line-referenced findings.
```

### Per-job model and thinking

A start task can temporarily override its child model and thinking level without changing the profile or parent session:

```json
{
  "task": "Review the authentication changes",
  "agent": "reviewer",
  "writeAccess": false,
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high"
}
```

Both fields are optional. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Model selection is job override, then profile, then parent session, then Pi's child default. A job model without a job thinking level inherits the parent thinking level when available.

Model values are opaque Pi IDs or patterns. Values such as `ollama/llama3.1:8b` and models with multiple colons are passed unchanged through `--model`; job thinking is passed separately through `--thinking`, so it overrides a thinking shorthand in the model pattern according to Pi's CLI precedence. Pi remains responsible for pattern resolution, model availability, provider credentials, and provider-specific validation.

Start and status views report **Launch model** and **Launch thinking**, which describe the arguments selected by this extension. Collected output reports Pi's **Reported model** separately; both model values are shown when resolution produces a different model ID. Overrides do not change the profile prompt, tools, access mode, working directory, parent model, or sibling jobs.

Use `subagent_agents({})` when profile names or capabilities are unknown. It returns profiles in discovery order (built-in `generic` first), including configured model inheritance and the read-only and writable tool allowlists passed when child Pi starts. These are launch ceilings, not guarantees of effective runtime tools: trusted child extensions may alter active tools.

A writable launch allowlist does not authorize a job to write. The parent must still start that job with `writeAccess: true`, and configured write confirmation still applies. Discovery never returns profile system prompts, profile file paths, raw frontmatter, discovery diagnostics, credentials, or parent session context.

Jobs are read-only by default. The parent model can explicitly request write access for a job; writable jobs may ask for confirmation through `~/.pi/agent/simple-subagents.json`:

```json
{ "confirmWrites": false }
```

`confirmWrites` defaults to `false`. Even when write access is requested, give concurrent writers non-overlapping work: all subagents share the same workspace, so overlapping writes can conflict.

## Limits and lifecycle

`subagent_wait` is an event-driven pause for jobs expected to finish when no useful parent work can proceed. The parent cannot answer concurrently while the tool is waiting, so each call defaults to 60 seconds and lasts at most 5 minutes. The wait returns immediately when its requested jobs settle; the configured timeout is only an upper bound. A timeout returns current states without cancelling work; do not immediately wait again—continue other work or return control. Aborting the parent turn does not cancel subagents. When the parent is not waiting, use `subagent_status` or the dashboard to check progress.

At most four jobs run at once, and a start or control batch accepts at most eight jobs. Collected output is capped at 50 KB. Cancel queued or running work from the tools or dashboard; session shutdown also cancels queued and active jobs before the extension closes.

The inbox is memory-only. Uncollected results are lost on `/reload`, session replacement, or Pi exit, so collect important output before changing sessions.
