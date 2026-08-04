# Disable Per-Job Thinking Overrides

## Goal

Prevent the parent agent from choosing a thinking level when it starts a subagent. This removes an easy path for the parent to launch every child with expensive reasoning.

## Public behavior

`subagent_start` will no longer accept `thinkingLevel` for a task. Callers that supply the removed property will be rejected by the tool schema rather than having it silently ignored.

Child thinking selection will use this precedence:

1. The selected agent profile's `thinking` value
2. The parent session's thinking level
3. Pi or the selected model's default

A profile remains the explicit place where a user can choose a different thinking level for a class of subagent. The built-in `generic` profile has no fixed thinking value and therefore inherits from the parent when possible.

## Implementation

Remove per-job thinking from the complete request path:

- Remove `thinkingLevel` from the `subagent_start` task schema and tool description.
- Remove it from task-to-request conversion and `JobRequest`.
- Remove job-level validation and precedence from launch option resolution.
- Remove the `job` launch-thinking source if no persisted or display code requires backward compatibility.
- Keep profile and parent thinking handling unchanged.
- Keep passing a selected level to child Pi through `--thinking`; model identifiers remain separate.

No configuration switch or hidden internal override will be retained. This prevents the feature from being restored accidentally through another caller.

## Reporting and compatibility

Status and result views continue to report the selected launch thinking and its source. New jobs can report `profile`, `parent`, or `model_or_pi_default`, but never `job`.

Removing the task property is an intentional public API change. Agent profiles that already define `thinking` continue to work. Existing model selection, child tool access, write authorization, concurrency, cancellation, and lifecycle behavior must not change.

## Error handling

TypeBox schema validation is the boundary for removed public input. Internal launch resolution should not accept or silently process a job thinking value. Existing profile validation remains responsible for rejecting unsupported profile thinking levels.

## Testing

Tests will verify:

- The start-task schema no longer exposes or accepts `thinkingLevel`.
- Task conversion cannot create a per-job thinking override.
- Profile thinking wins over parent thinking.
- Parent thinking is used when the profile does not set one.
- Pi/model default is used when neither profile nor parent sets one.
- Launch arguments and status sources cannot identify a new job override.
- Existing model override behavior remains unchanged.

Run focused tests, the full test suite, TypeScript type checking, and diagnostics for edited files before completion.

## Scope

Update source, tests, and README text that documents per-job thinking. Do not alter unrelated in-progress workspace changes or add a general policy/configuration system.
