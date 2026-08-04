# Gate Per-Job Thinking Overrides Behind User Configuration

## Goal

Prevent the parent agent from choosing a subagent thinking level by default while preserving per-job overrides as an explicit user-controlled option.

## Configuration

Use the existing user configuration file:

`~/.pi/agent/simple-subagents.json`

```json
{
  "confirmWrites": false,
  "allowThinkingOverrides": false
}
```

`allowThinkingOverrides` is optional and defaults to `false`. It must be a Boolean when present. A missing, unreadable, malformed, or invalid setting fails closed to `false` and emits the existing configuration warning mechanism where applicable.

The setting is user-global. It is not available as a project, profile, task, or tool-call option. Editing the file takes effect after `/reload` or a Pi restart.

## Public behavior

When `allowThinkingOverrides` is `false`:

- `subagent_start` does not expose `thinkingLevel` in its task schema.
- A task containing `thinkingLevel` fails schema validation rather than being silently accepted.
- Defense-in-depth request conversion discards an injected `thinkingLevel` even if another extension mutates tool input after schema validation.
- Thinking precedence is profile `thinking`, parent session thinking, then Pi/model default.

When `allowThinkingOverrides` is `true`:

- `subagent_start` exposes and accepts the seven normalized levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Existing precedence remains job `thinkingLevel`, profile `thinking`, parent session thinking, then Pi/model default.

The built-in `generic` profile has no fixed thinking value and inherits parent thinking unless an enabled per-job override is supplied.

## Architecture

Configuration must be loaded before `subagent_start` is registered. Pi supports tool registration during `session_start`, so the extension will load configuration and profiles first and then register the subagent tools with the selected schema. Session replacement and `/reload` create a fresh extension runtime, allowing configuration changes to select a new schema safely.

Use two strict TypeBox start-task schemas built from the same shared fields:

- Disabled schema: no `thinkingLevel`, with unknown task properties rejected.
- Enabled schema: optional normalized `thinkingLevel`, with unknown task properties rejected.

Tool execution also receives the resolved policy. Request conversion copies `thinkingLevel` only when overrides are enabled. This protects the policy because Pi's `tool_call` event permits other extensions to mutate input after validation without another validation pass.

Keep `thinkingLevel` in the internal `JobRequest` and keep the `job` launch-thinking source because the enabled mode still uses both. Launch resolution receives only policy-filtered requests and retains existing validation and precedence.

## Configuration error handling

Configuration fields are validated independently:

- Missing file: `{ confirmWrites: false, allowThinkingOverrides: false }`.
- Valid fields: preserve both values.
- Invalid `confirmWrites`: retain its current fail-safe value of `true`.
- Invalid `allowThinkingOverrides`: use `false`.
- Unreadable file or invalid JSON/object: use `confirmWrites: true` and `allowThinkingOverrides: false`.

Warnings must identify the invalid field. A valid `allowThinkingOverrides` value must not be lost merely because `confirmWrites` is invalid, and vice versa.

## Reporting and compatibility

Existing launch, status, and collected-result reporting remains unchanged. Jobs can still report `job override`, `profile`, `parent session`, or `model or Pi default`, depending on the enabled policy and selected source.

Existing agent profiles continue to work. Per-job model overrides remain available in both modes. Model identifiers and thinking remain separate; reserved thinking suffixes in model IDs remain invalid.

No configuration migration is required because omission produces the new safe default. Users who need the old behavior can restore it explicitly by setting `allowThinkingOverrides` to `true` and reloading Pi.

Existing child tool access, write authorization, concurrency, cancellation, process handling, capture, lifecycle, and model behavior must not change.

## Testing

Tests will verify:

- Missing and invalid configuration defaults thinking overrides to disabled.
- Both Boolean values are preserved and invalid fields fail independently.
- Disabled registration omits and rejects `thinkingLevel`.
- Enabled registration exposes and accepts every supported level.
- Disabled request conversion strips post-validation injected input.
- Enabled requests retain existing job-first precedence.
- Disabled requests use profile, parent, and default precedence.
- Tool registration occurs after configuration and profile loading.
- `/reload`-style fresh initialization can choose the other schema.
- Existing model overrides, launch arguments, source reporting, and lifecycle behavior remain unchanged.

Run focused tests, the full test suite, TypeScript type checking, and diagnostics for edited files before completion.

## Scope

Update configuration parsing, startup registration, tool schema construction, request conversion, tests, and README documentation. Do not add a runtime command, UI setting, project override, or unrelated refactor. Preserve unrelated uncommitted workspace changes by implementing in an isolated worktree.
