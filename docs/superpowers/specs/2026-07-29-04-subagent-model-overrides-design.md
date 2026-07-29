# 04 — Per-Job Model and Thinking Override Design

## Summary

Allow each `subagent_start` task to select an optional model and thinking level. Temporary cost/quality choices no longer require permanent profile files for every model and role combination. Overrides affect only the selected job and do not change its profile prompt, tools, access mode, or the parent session.

This feature is independently releasable. Profile discovery improves usability but is not required.

## Goals

- Select a model per job.
- Select a Pi-supported thinking level per job.
- Define deterministic precedence among job, profile, and parent defaults.
- Show the child launch selections immediately after enqueue.
- Preserve the model later reported by the child.
- Keep existing start calls byte-for-byte compatible at the process-argument boundary.

## Non-goals

- Changing the parent session’s model or thinking level.
- Discovering all provider models.
- Authenticating providers inside the extension.
- Altering profile prompts or tool permissions.
- Automatically choosing models based on task content.
- Adding cost budgets or routing policies.
- Adding a separate thinking-level field to profile frontmatter.
- Reimplementing Pi’s model-pattern resolver.

## Public interface

Extend each `subagent_start.tasks[]` entry:

```ts
{
  task: "Review the authentication changes",
  agent: "reviewer",
  writeAccess: false,
  model: "anthropic/claude-sonnet-4-5",
  thinkingLevel: "high"
}
```

Both fields are optional. `thinkingLevel` uses `StringEnum` with Pi’s supported values:

```text
off, minimal, low, medium, high, xhigh, max
```

`model` is a non-empty, trimmed string without control characters. It is an opaque Pi model ID or pattern and may contain any number of colons. The extension does not split or rewrite it. Pi remains responsible for model-pattern resolution, model existence, provider authentication, and provider-specific validation.

## Precedence and launch behavior

Model selection precedence:

1. Per-job `model`.
2. Profile `model`.
3. Parent session model.
4. Child Pi’s default when none is available.

Thinking selection precedence:

1. Per-job `thinkingLevel`.
2. Existing profile/parent behavior when no per-job fields are present.
3. Parent session thinking level for a new per-job model when available.
4. Child Pi’s model suffix or default when no explicit thinking selection is available.

Pi already supports separate CLI arguments:

```text
--model <opaque model ID or pattern>
--thinking <level>
```

The extension uses `--thinking` for job-level thinking rather than encoding or replacing a suffix in `--model`. Pi gives explicit `--thinking` precedence over a thinking shorthand embedded in a model pattern. Therefore a job-level thinking override reliably overrides a profile model such as `anthropic/claude-sonnet-4-5:high` without the extension guessing whether `:high` is part of a real model ID.

### Compatibility path

When neither new field is supplied, the process runner follows its existing model/thinking argument construction unchanged. This preserves current profile suffix and parent-inheritance behavior for every legacy call.

### Override path

When either new field is supplied:

- Select the model using the precedence above and pass it unmodified through `--model` when available.
- If `thinkingLevel` is supplied, pass it through `--thinking`.
- If a per-job `model` is supplied without `thinkingLevel`, pass the parent session thinking level through `--thinking` when available; otherwise let Pi resolve any model shorthand or default.
- If only `thinkingLevel` is supplied, select the profile or parent model normally and pass the job level through `--thinking`.
- If only `thinkingLevel` is supplied and no model is known, omit `--model`; child Pi selects its default model while honoring `--thinking`.

Examples:

```text
Profile model: anthropic/claude-sonnet-4-5:high
Job thinkingLevel: low
Arguments: --model anthropic/claude-sonnet-4-5:high --thinking low
```

```text
Job model: ollama/llama3.1:8b
Parent thinking: high
Arguments: --model ollama/llama3.1:8b --thinking high
```

The extension never strips `:high`, rewrites `:8b`, or rejects a model merely because its final colon segment resembles a thinking level.

## Job data

Extend `JobRequest` with:

```ts
model?: string;
thinkingLevel?: ThinkingLevel;
```

Add launch-selection fields to `Job`:

```ts
launchModel?: string;
launchThinkingLevel?: ThinkingLevel;
launchThinkingSource?: "job" | "parent" | "model_or_pi_default" | "legacy";
```

These fields describe the arguments selected by the extension, not a claim about the provider model Pi ultimately resolves. They are set when the job is enqueued and are visible in start and status results.

The existing `job.model` field retains its current lifecycle and meaning: it is not populated early or overwritten during enqueue, and `JobManager.applyResult()` sets it from `ProcessResult.model`. This preserves existing renderers and consumers. If `job.model` later differs from `launchModel`, collected output displays both as **Launch model** and **Reported model**.

## Architecture

Add a pure `resolveLaunchOptions()` helper that accepts the request, selected profile, and parent defaults. It returns:

- Whether the legacy or override path applies.
- Opaque model argument, if any.
- Explicit thinking argument, if any.
- Launch metadata for the job snapshot.
- Validation diagnostics for the new fields.

`JobManager.enqueue()` validates and resolves every task before mutating manager state. One invalid override rejects the complete batch, matching unknown-profile behavior.

The process runner consumes the prepared launch options. It does not parse colon suffixes in the override path. The existing legacy resolver remains isolated for no-override calls until a separate compatibility change is intentionally designed.

## Launch and failure behavior

The extension validates input shape but does not query provider credentials. If Pi rejects an unavailable, ambiguous, or unauthenticated model after enqueue, the job becomes `failed` through the existing process-result path. Diagnostics include the launch model selection and Pi error. Sibling jobs remain unaffected.

A thinking override without a known model remains valid because Pi supports `--thinking` independently and can apply it to its default model.

## Permissions and isolation

Model and thinking overrides do not modify:

- `AgentProfile.systemPrompt`.
- Child tool launch allowlists.
- `writeAccess`.
- Write confirmation.
- Working directory.
- Parent model selection.
- Other jobs in the same batch.

## Rendering

Start results and dashboard details show launch selections without overstating resolution:

```text
Launch model: anthropic/claude-sonnet-4-5
Launch thinking: high (job override)
```

Collected results show the child-reported model when available. If it differs from the launch selection, both values are retained. Compact rendering remains concise.

## Error handling

- Empty or control-character model strings fail before enqueue.
- Invalid thinking levels fail schema validation.
- Colon-bearing model strings are passed through unchanged.
- A job-level `--thinking` value overrides profile model shorthand through Pi’s documented CLI precedence.
- Unknown model/provider/authentication errors produce a failed inspectable job.
- A batch with one pre-enqueue validation error creates no jobs.

## Testing strategy

A table-driven suite covers:

- Job, profile, parent, and child-default model selection.
- Job thinking overriding profile shorthand.
- Job model inheriting parent thinking.
- Thinking override with no known model.
- Ollama tags and model IDs ending in strings such as `:high`.
- Every supported thinking level.
- Missing parent model or thinking level.
- Empty and control-character model strings.
- Atomic batch rejection.
- Immediate launch metadata.
- Exact `--model` and `--thinking` subprocess arguments.
- Proof that colon-bearing model values are not rewritten.
- Unavailable-model failure diagnostics.
- Reported-model agreement and disagreement.
- Start, status, dashboard, and collection rendering.
- Legacy requests producing unchanged arguments.

A focused real-Pi integration test verifies that explicit `--thinking` overrides model shorthand according to the supported Pi CLI behavior when credentials are available.

## Documentation

The README will document precedence, opaque model handling, separate `--thinking` behavior, supported thinking levels, launch-versus-reported terminology, and the fact that Pi validates model availability and authentication.

## Success criteria

- A parent can choose cost and reasoning settings for one job without creating a profile.
- Job-level thinking overrides profile model shorthand without parsing model IDs.
- Immediate display accurately describes launch selections rather than claiming provider resolution.
- Model overrides never change tools or write access.
- Existing start requests retain their current process arguments and `job.model` lifecycle.
