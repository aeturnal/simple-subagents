# Simple Subagents Design

## Summary

`simple-subagents` is a lightweight Pi extension for running isolated subagents concurrently as background jobs. Jobs execute in separate Pi subprocesses, remain outside the parent model's context while running, and place completed results in an inbox. The parent session receives only a small completion notice and asks the user whether to collect the full result.

Version one intentionally avoids persistent workers, restart recovery, worktrees, and automatic merge handling.

## Goals

- Run multiple Pi subagents concurrently without blocking the parent session.
- Show live job state through a compact widget and an interactive dashboard.
- Allow queued or running jobs to be cancelled.
- Keep subagent output out of parent context until explicitly collected.
- Support a generic agent plus optional named user profiles.
- Permit concurrent shared-workspace writes when the parent model determines they are needed.
- Remain small enough to understand, test, and maintain easily.

## Non-goals

- Jobs surviving Pi exit, reload, or session replacement.
- Continuing conversations with a completed subagent.
- Project-local agent profiles in version one.
- Git worktree isolation, merge automation, or conflict resolution.
- Automatic synchronization of parent conversation updates into running agents.
- Guaranteed safety for concurrent workspace modifications.

## Architecture

The extension registers model-facing tools, a slash command, renderers, and session lifecycle handlers around one session-scoped `JobManager`.

Each job is a one-shot Pi subprocess launched in JSON mode:

```text
pi --mode json -p --no-session [model/tool/system-prompt options] "Task: ..."
```

The subprocess emits structured JSON events on standard output. The manager parses those events to capture progress, assistant messages, tool activity, usage, errors, and final output. Standard error is retained for diagnostics.

Separate processes provide context and failure isolation while reusing the user's normal Pi authentication, provider, model, and tool behavior. This is preferred over in-process `AgentSession` instances because the extension only needs independent one-shot jobs and prioritizes lifecycle simplicity over lower startup overhead.

## Components

### Extension entry point

The entry point registers:

- `subagent_start`: launch one or more background jobs.
- `subagent_status`: list jobs or inspect one job's state and progress.
- `subagent_control`: cancel, collect, or discard jobs.
- `/subagents`: open the interactive dashboard.
- A conditional status widget.
- Session shutdown cleanup.

### JobManager

The `JobManager` owns:

- Queued and active jobs.
- A global concurrency limit of four running jobs.
- Child process and abort state for each running job.
- Parsed progress, partial output, final output, and usage.
- Inbox state and collection state.
- Subscriber notifications used to rerender the widget and dashboard.

One `subagent_start` call may enqueue at most eight jobs. All jobs, including writable jobs, use the same concurrency pool.

### Process runner

The process runner:

- Builds a shell-free Pi invocation.
- Writes non-empty profile prompts to permission-restricted temporary files.
- Parses newline-delimited JSON events incrementally.
- Captures stderr and process errors.
- Propagates cancellation to the child process.
- Removes temporary files during cleanup.

### Agent discovery

The extension always exposes a built-in `generic` agent. Optional named profiles are loaded from:

```text
~/.pi/agent/agents/*.md
```

Project-local profiles are excluded in version one to keep discovery and trust behavior simple.

A profile uses YAML frontmatter followed by its system prompt:

```markdown
---
name: reviewer
description: Reviews code for correctness and maintainability
model: openai-codex/gpt-5.6-sol
tools: read, grep, find, ls
---

Review code carefully. Return findings with file and line references.
```

Invalid profiles are skipped and surfaced as discovery diagnostics. Profile names must be unique; deterministic filename order is used, with the first valid definition winning.

## Job model and state transitions

Each job contains:

- Stable runtime ID such as `job-42`.
- Agent name and resolved profile.
- Self-contained task brief.
- Working directory.
- Read/write access mode.
- Queue, start, and finish timestamps.
- Child process and cancellation state while running.
- Progress items, stderr, usage, and final output.
- Current lifecycle state.

States are:

```text
queued -> running -> completed -> collected or discarded
                  -> failed    -> collected or discarded
queued/running    -> cancelled -> collected or discarded
```

Terminal operations are idempotent. A repeated cancel, collect, or discard reports the existing state rather than corrupting it.

## Context handling

Subagents do not receive the parent conversation automatically. The parent model must provide a self-contained task containing only the objective, constraints, useful file paths or findings, and expected output. Subagents inspect the shared working directory using their own tools.

While a job runs, progress and output remain in extension-managed memory and do not consume parent context.

When a job settles, the extension queues a lightweight custom follow-up message:

```text
job-42 completed and is available in the subagent inbox. Ask the user whether they want to collect it.
```

The notice waits until the parent agent settles if it is busy. Completion notices that become ready together may be combined into one message. The notice contains no full result body.

Collecting a job inserts a structured result into parent context with:

- Job ID and status.
- Agent name.
- Original task.
- Access mode.
- Model and usage information when available.
- Reported changed files when available.
- Final output or failure diagnostics.

Collection through `subagent_control` naturally enters context as a tool result. Collection from `/subagents` inserts the same payload as a displayed custom message. A collected result remains part of the Pi session and therefore survives normal session persistence and compaction.

## Models and tools

The generic agent inherits the parent session's active model and thinking level at launch. A named profile may override its model. Profile model resolution failures fail the job before launch with an actionable error.

Read-only jobs receive this default tool set:

```text
read, grep, find, ls
```

The parent model sets `writeAccess: true` when delegated work requires modifications. Writable jobs may additionally receive:

```text
edit, write
```

A profile's requested tools are intersected with the tools permitted by the access mode. Version one does not include `bash` by default because it cannot be reliably classified as read-only. A profile may request `bash`; doing so is permitted only for a writable job.

The main tool description instructs the parent model to keep jobs read-only unless modification is necessary and to assign concurrent writable jobs non-overlapping files or areas whenever possible.

## Write confirmation configuration

Write confirmation is disabled by default. The parent model may launch writable jobs without a prompt.

Users may create:

```text
~/.pi/agent/simple-subagents.json
```

with:

```json
{
  "confirmWrites": true
}
```

When enabled, each requested writable batch requires interactive confirmation before jobs are queued. If confirmation is required but interactive UI is unavailable, writable jobs are rejected. Missing configuration uses defaults. Invalid configuration produces a visible warning and uses safe defaults, including requiring confirmation if `confirmWrites` has an invalid non-boolean value.

## Shared workspace behavior

All jobs run in the selected working directory. Concurrent writable jobs are allowed and may modify the same workspace simultaneously.

The extension does not provide cross-process file locks. Two agents editing the same file, running Git operations, or executing interfering commands can conflict. This risk is documented in tool guidance and the package README. Parent agents should partition writable tasks into non-overlapping areas.

Worktree isolation may be considered later but is outside version one.

## User interface

### Compact widget

The widget is visible only when at least one job is queued, running, or awaiting collection or dismissal:

```text
● Subagents · 2 running · 1 ready
```

It disappears when no jobs need attention.

### Dashboard

`/subagents` opens a keyboard-controlled TUI dashboard:

```text
BACKGROUND AGENTS

RUNNING
  ● job-42  reviewer  1m 12s  Review authentication
  ● job-43  scout       18s  Find relevant tests

INBOX
  ✓ job-39  planner          Ready to collect
  ✗ job-40  worker           Failed

↑↓ navigate · enter inspect · c cancel · x collect · d discard · esc close
```

The dashboard supports:

- Navigation through jobs.
- Compact and detailed inspection.
- Live progress updates.
- Cancellation of queued or running jobs.
- Collection or discard of settled jobs.
- Viewing partial output and diagnostics from failed or cancelled jobs.

Writable jobs display a clear write indicator. All rendered lines are ANSI-aware and constrained to terminal width.

## Cancellation and shutdown

Cancelling a queued job removes it from the queue and marks it cancelled.

Cancelling a running job:

1. Aborts its controller.
2. Sends `SIGTERM` to the child process.
3. Waits up to five seconds.
4. Sends `SIGKILL` if the process remains alive.
5. Preserves captured partial output and diagnostics in the inbox.

The manager removes abort listeners and timers when a child settles.

On `session_shutdown`, including quit, reload, new session, resume, or fork, the extension cancels every queued or running job and waits for child cleanup. Uncollected in-memory inbox results are discarded. Results collected into the Pi session remain there.

## Output limits

Model-visible collected output is capped at 50 KB per job. Truncated payloads state how much content was omitted. Full captured output remains available in memory through the dashboard until the job is collected, discarded, or the session shuts down.

Progress rendering retains a bounded recent event history plus the latest partial assistant output so long-running jobs cannot grow memory without limit. Final output and diagnostics retain their own explicit byte caps, with truncation metadata.

## Error handling

- Unknown agent names fail before launch and list available profiles.
- Invalid invocation shapes return clear tool errors.
- Child spawn errors create failed inbox entries.
- Malformed JSON lines are ignored and counted; representative samples are retained for diagnostics.
- Non-zero exits, assistant error stop reasons, and missing final output create failed entries.
- One failed job does not cancel sibling jobs.
- Completion notification failures do not lose inbox results.
- Cancellation races settle once and preserve the first terminal state.
- Tool execution throws only for extension-level failures; ordinary job failures are represented as inspectable job states.

## Testing strategy

### Unit tests

- Job state transitions and idempotent terminal operations.
- Queue and concurrency limits.
- Agent profile parsing, ordering, and validation.
- Tool permission intersection and write configuration.
- Incremental JSON parsing with split and malformed lines.
- Cancellation escalation and race handling.
- Output and progress-history truncation.

### Component tests

- `JobManager` behavior with fake child processes.
- Tool start, status, cancel, collect, and discard behavior.
- Batched completion notices.
- Session shutdown cleanup.
- Widget counts and visibility.
- Dashboard actions and width-constrained rendering.

### Integration and manual tests

- Spawn a real no-session Pi subprocess for a trivial prompt when credentials are available.
- Verify abort propagation to a running subprocess.
- Verify generic and named-profile model/tool arguments.
- Manually verify live dashboard updates, collection, write indicators, narrow terminals, and theme changes.

## Packaging

The repository is a Pi package with its extension declared in `package.json` under `pi.extensions`. Pi core packages and `typebox` are peer dependencies. Tests and TypeScript tooling are development dependencies; runtime code relies only on Pi's bundled extension APIs and Node.js built-ins.

The README documents local installation, `pi install` usage, profile format, commands, configuration, shared-workspace risks, output limits, and shutdown behavior.

## Success criteria

Version one is successful when:

- The parent agent can launch up to eight jobs without blocking its session.
- Four jobs can stream progress concurrently.
- The user can inspect and cancel jobs from `/subagents`.
- Finished results remain outside parent context until collection.
- The parent receives a lightweight availability notice and asks before collection.
- Generic and user-level named agents work.
- Read-only and writable jobs receive the correct tool sets.
- Concurrent writable jobs are supported with documented conflict risk.
- Reload, replacement, and exit reliably terminate child processes.
- Automated tests cover the job lifecycle and critical failure paths.
