# Profile Thinking Configuration Design

## Goal

Add explicit Pi-normalized thinking configuration to agent profile frontmatter and stop encoding thinking levels in model strings.

## Motivation

Agent profiles currently store only `model`. Thinking is selected by per-job override, inherited parent state, or a legacy `:<level>` model suffix. The suffix form mixes two settings, makes profile intent difficult to validate and display, and lets a model value implicitly alter thinking.

The child-completion lifecycle bug is fixed separately in v0.8.1. This design does not remove deliberate per-job thinking overrides. It adds a clear profile default and removes suffix-based thinking syntax.

## Profile Format

A user profile may define an optional `thinking` field:

```yaml
---
name: reviewer
description: Review changed code
model: openai-codex/gpt-5.6-sol
thinking: medium
tools: read, grep
---
```

The field accepts Pi's normalized thinking levels exactly:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
- `max`

The value is case-sensitive and must not contain leading or trailing whitespace. Missing `thinking` means the profile has no configured default.

`simple-subagents` does not expose provider-native token budgets or separate Anthropic, Google, and OpenAI enums. Pi maps and clamps its normalized levels for the selected provider and model. Anthropic adaptive effort and older token-budget thinking, Gemini thinking levels and budgets, and OpenAI reasoning effort remain Pi responsibilities.

## Selection Precedence

Model selection remains:

1. Per-job `model`
2. Profile `model`
3. Parent session model
4. Pi child default

Thinking selection becomes:

1. Per-job `thinkingLevel`
2. Profile `thinking`
3. Parent session thinking level
4. Pi or model default

A profile value is a default, not a lock. A deliberate per-job `thinkingLevel` remains allowed and takes precedence.

When a level is selected from the job, profile, or parent, the runner passes it as a separate `--thinking <level>` argument. When no level is available, the runner passes no `--thinking` argument.

## Model Suffix Rejection

Profile and per-job model values must not end with a final colon segment equal to one of Pi's seven thinking levels.

Rejected examples:

```text
openai-codex/gpt-5.6-sol:high
anthropic/claude-opus:max
google/gemini-3-pro:minimal
```

Accepted examples:

```text
ollama/llama3.1:8b
vendor/model:preview
vendor/model:real:tag
```

Only the final colon segment is examined. Ordinary model tags remain opaque and unchanged. A model whose real identifier ends in one of the seven reserved words is intentionally unsupported through `simple-subagents`; the caller must use a model identifier without that ambiguous suffix.

Suffix rejection applies even when a separate job or profile thinking value is present. The extension never strips, rewrites, or silently ignores a forbidden suffix.

## Shared Validation

One small internal thinking-validation module owns:

- The supported-level membership check.
- Exact parsing of profile values.
- Detection of a reserved final model suffix.

Profile discovery and launch resolution use the same helper so their accepted values cannot drift.

`THINKING_LEVELS` and `ThinkingLevel` remain the canonical public constants and type. The validation helper consumes them rather than defining a second list.

## Profile Discovery

`AgentProfile` gains optional `thinking?: ThinkingLevel`.

Discovery behavior:

- A missing field is accepted as inheritance.
- A valid field is stored on the profile.
- An invalid type or value excludes only that profile.
- A profile model with a reserved thinking suffix excludes only that profile.
- Diagnostics identify the file, the invalid field or suffix, the correction, and the allowed thinking values where relevant.
- Discovery continues processing later profiles after an invalid profile.

The built-in `generic` profile has no configured thinking and therefore inherits from the parent when available.

## Launch Resolution

Launch resolution validates the per-job model before creating jobs. Existing non-empty, trimmed, control-character model validation remains in place. Reserved thinking-suffix validation is added after that basic validation.

A reserved suffix produces a launch diagnostic. `JobManager.enqueue` already prevalidates all selected launch options before mutating job state, so one invalid per-job model rejects the complete batch atomically.

The legacy resolver path that appends thinking to model strings is removed. `LaunchOptions.path` is removed because the `legacy` and `override` distinction no longer controls launch construction.

`LaunchThinkingSource` becomes:

- `job`
- `profile`
- `parent`
- `model_or_pi_default`

The old `legacy` source is removed.

## Reporting

Jobs continue storing the resolved launch model, launch thinking level, and launch thinking source.

`subagent_status`, dashboard launch details, start/control tool details, and collected output identify profile-derived launch thinking as `profile`. Existing `job`, `parent`, and Pi-default source reporting remains. The compact live widget continues showing the selected thinking level where it already does; it does not gain new source-detail text.

`PublicAgentProfile` adds these exact safe fields:

```ts
thinking: ThinkingLevel | null;
inheritsParentThinking: boolean;
```

A configured profile reports its value and `inheritsParentThinking: false`. A profile without a value reports `thinking: null` and `inheritsParentThinking: true`.

No system prompt, raw frontmatter, profile path, or other private profile data is exposed.

## Error Messages

Profile diagnostics use clear forms equivalent to:

```text
Skipped <path>: thinking must be one of off, minimal, low, medium, high, xhigh, max
Skipped <path>: model must not encode thinking with the reserved suffix :high; use thinking: high
```

Per-job launch diagnostics use a clear form equivalent to:

```text
Model must not encode thinking with the reserved suffix :high; use thinkingLevel instead
```

Exact punctuation may follow existing project style, but tests assert the field, offending suffix, and correction guidance.

An unsupported parent thinking string is treated as unavailable. It does not fail the job because the parent value comes from Pi runtime context; the child falls back to Pi or model defaults.

Provider-specific incompatibility with a valid Pi thinking level remains a child Pi validation error. `simple-subagents` does not maintain a provider capability table.

## Migration

The four installed user profiles migrate from:

```yaml
model: openai-codex/gpt-5.6-sol:medium
```

To:

```yaml
model: openai-codex/gpt-5.6-sol
thinking: medium
```

Affected files:

- `~/.pi/agent/agents/reviewer.md`
- `~/.pi/agent/agents/security-auditor.md`
- `~/.pi/agent/agents/test-automator.md`
- `~/.pi/agent/agents/typescript-pro.md`

README examples use explicit profile thinking and state that thinking suffixes are unsupported. Per-job `thinkingLevel` remains documented as the highest-precedence temporary override.

## Tests

Focused tests cover:

1. Every Pi thinking level is accepted by shared validation and profile discovery.
2. Invalid strings, wrong types, surrounding whitespace, case variants, and near-matches are rejected.
3. Ordinary final colon tags remain valid and opaque.
4. Each reserved final suffix is detected.
5. Invalid profile thinking excludes only the affected profile and emits a useful diagnostic.
6. A profile model suffix excludes only the affected profile and recommends `thinking:`.
7. A per-job model suffix rejects the complete batch before creating or starting jobs.
8. Job thinking overrides profile thinking.
9. Profile thinking overrides parent thinking.
10. Parent thinking is selected when the profile omits thinking.
11. No available thinking value produces no `--thinking` argument.
12. Model and thinking remain separate process arguments for generic, named, read-only, and writable jobs.
13. Public profile discovery and all status presentations report profile thinking correctly.
14. The old real-Pi model-suffix integration test is replaced with an explicit profile-thinking integration test.
15. Existing child extension isolation, model selection, tool access, cancellation, capture, activity, and process-close behavior remain unchanged.

## Documentation

README documentation explains:

- The optional `thinking` profile field.
- Pi's seven normalized values.
- Selection precedence.
- Reserved suffix rejection with accepted and rejected examples.
- Pi's responsibility for provider-specific mapping.
- The continued availability of deliberate per-job overrides.

## Non-Goals

This change does not:

- Remove or lock per-job thinking overrides.
- Add maximum-thinking caps or policy configuration.
- Add provider-specific values or numeric thinking budgets.
- Change models based on thinking level.
- Change child extension isolation, lifecycle settlement, cancellation, deadlines, activity heartbeats, concurrency, or write authorization.
- Publish a release; release versioning and publication are separate follow-up decisions.
