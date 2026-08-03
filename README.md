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

Ask Pi naturally: “start three parallel subagents to review the tests, dependencies, and docs”; “show subagent status”; “wait for job-1 and job-3”; “cancel job-2”; or “collect job-1 and job-3.” `/subagents` opens a read-only inspection dashboard: arrows select jobs, Enter toggles compact details, `v` opens or closes the scrollable full view, Page Up/Page Down and Home/End scroll full details, `c` cancels queued or running work, and Escape returns from full view or closes the dashboard.

While jobs are queued or running, an above-editor tree shows each active subagent, its latest bounded activity, turns, tool uses, tokens, and elapsed time. Running rows use an animated spinner. Completed, failed, and cancelled rows remain visible for three seconds; `/subagents` remains the durable inbox view until the parent collects or discards a result.

Model-turn and reasoning events appear as fixed activity such as `Model turn started` and `Model reasoning`. During a long reasoning stream, the extension refreshes one bounded activity timestamp at most every five seconds. It never captures or displays the model's reasoning text. Heartbeats depend on the selected provider and model emitting Pi reasoning events; the extension does not invent activity when no event arrives.

`subagent_status` reports bounded task, state, timing, profile, access, launch/reported model, usage, and up to three recent activity previews. It never returns the complete captured answer, stderr, error body, malformed protocol samples, or profile prompt. A completed status points the parent to `subagent_control` to collect the result.

```text
job-2 — running · running for 2m 14s
Task: Review authentication changes
Agent: reviewer · Access: read-only
Model: openai-codex/gpt-5.6-terra · Thinking: medium (job override)
Usage: 28000 input · 3000 output · 6 turns · $0.08
Recent activity:
  4s ago   Completed read
  2s ago   Started lsp_diagnostics
  now      Model reasoning
```

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

At most four jobs run at once, and a start or control batch accepts at most eight jobs. Collected output is capped at 50 KB. Cancel queued or running work from the tools or dashboard. Collection and discard are parent-agent operations through `subagent_control`; the dashboard never injects a result into the conversation. Session shutdown cancels queued and active jobs before the extension closes.

The inbox is memory-only. Uncollected results are lost on `/reload`, session replacement, or Pi exit, so collect important output before changing sessions.
