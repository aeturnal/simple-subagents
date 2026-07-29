# simple-subagents

Lightweight background Pi subagents. Start independent work in parallel, inspect it while it runs, and collect only the results you need.

## Use locally

```sh
pi install .
pi -e ./src/index.ts
```

Ask Pi naturally: “start three parallel subagents to review the tests, dependencies, and docs”; “show subagent status”; “cancel job-2”; or “collect job-1 and job-3.” `/subagents` opens the interactive inbox: arrows select, Enter inspects, `c` cancels, `x` collects, `d` discards, and Escape closes.

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

Jobs are read-only by default. The parent model can explicitly request write access for a job; writable jobs may ask for confirmation through `~/.pi/agent/simple-subagents.json`:

```json
{ "confirmWrites": false }
```

`confirmWrites` defaults to `false`. Even when write access is requested, give concurrent writers non-overlapping work: all subagents share the same workspace, so overlapping writes can conflict.

## Limits and lifecycle

At most four jobs run at once, and a start or control batch accepts at most eight jobs. Collected output is capped at 50 KB. Cancel queued or running work from the tools or dashboard; session shutdown also cancels queued and active jobs before the extension closes.

The inbox is memory-only. Uncollected results are lost on `/reload`, session replacement, or Pi exit, so collect important output before changing sessions.
