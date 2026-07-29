# 06 — Clear Subagent State Terminology Design

## Summary

Use consistent human-facing labels that distinguish extension process lifecycle from the meaning of a subagent’s answer. A process can finish successfully while its result reports that the task was blocked or incomplete. The interface will therefore call lifecycle values **Process state** and reserve **Result** for free-form subagent output.

This is an independently releasable terminology change. Machine-readable field names and state transitions remain unchanged.

## Goals

- Make `completed` mean clearly that the subprocess completed, not that the task succeeded.
- Label free-form subagent output consistently as `Result`.
- Keep provider termination information labeled `Stop reason`.
- Keep technical failures labeled `Diagnostics`.
- Apply terminology consistently across tools, notifications, dashboard, collection, and documentation.
- Preserve machine compatibility.

## Non-goals

- Parsing `DONE`, `BLOCKED`, `NEEDS_CONTEXT`, or similar prose.
- Adding a structured semantic outcome.
- Changing `JobState` values or transitions.
- Renaming TypeScript fields or tool-detail fields.
- Reclassifying a completed process based on its answer.
- Changing success/failure detection in the process runner.

## Terminology contract

### Process state

The extension-controlled lifecycle value:

```text
queued, running, completed, failed, cancelled, collected, discarded
```

`completed` means the subprocess exited successfully with a usable final response under existing manager rules. It does not claim that the requested task was accomplished.

### Result and partial result

**Result** is the free-form final answer from a completed subagent. It may itself say that work succeeded, failed, was blocked, needs context, or completed with concerns. The extension does not infer a structured outcome from that prose.

**Partial result** is captured assistant prose from a failed or cancelled process. It is displayed separately from technical diagnostics and is not treated as a successful final answer.

### Stop reason

The stop reason reported by Pi or the provider, such as a normal stop or provider error. It remains distinct from process state and result meaning.

### Diagnostics

Technical information used to understand failed or cancelled execution, including stderr, process errors, malformed events, and capture-limit metadata.

## Examples

A subprocess that runs successfully but reports it could not finish the requested task renders:

```text
Process state: completed

## Result
I could not complete the task because the required credentials are unavailable.
```

A subprocess execution failure with captured assistant prose renders:

```text
Process state: failed

## Partial result
I inspected the parser but could not finish the review.

## Diagnostics
Error: Pi process exited before producing a final answer.
```

The first example is not relabeled `failed`, because semantic outcome parsing is outside this feature.

## User-interface changes

Update human-facing labels in:

- Collected-result metadata.
- Single-job status output.
- Expanded start and control tool rendering.
- Completion notification wording.
- Dashboard job details.
- README examples and lifecycle documentation.

Compact rows such as `job-2 running` may remain unlabeled when context is unambiguous. When a label appears, it uses `Process state`, not `Status` or `Agent outcome`.

Headings remain:

- `Result` for a completed process’s final answer.
- `Partial result` for assistant prose captured from a failed or cancelled process, including the latest partial text or captured output when available.
- `Diagnostics` for technical failure details only.
- `Stop reason` for provider termination.

`Stop reason` is added to collected-result metadata and dashboard job details when available. Other surfaces need not display it merely to satisfy this terminology change; richer status remains independently scoped.

## Machine compatibility

The following remain unchanged:

```ts
job.state
ToolDetails.jobs[].state
JobState
```

No enum member, serialized detail key, input schema, custom message type, or state transition changes. The feature updates text and rendering only.

A derived `processState` field is not added because it would duplicate `state` and create two machine sources of truth.

## Interaction with other numbered features

- Stale-safe notifications may already use “Jobs may be ready”; this feature updates any remaining state labels without changing notification logic.
- The wait tool continues returning machine field `state` while rendering `Process state` when labeled.
- Profile discovery has no lifecycle labels and requires no change.
- Model overrides retain `Launch model`, `Launch thinking`, and `Reported model` labels.
- Richer status already specifies `Process state`; this feature makes the same wording universal.

None of those features is a hard dependency.

## Error handling

There is no new runtime error path. Existing formatters must continue handling missing optional diagnostics, output, model, and stop-reason fields. Terminology changes must not suppress or reorder substantive diagnostic content.

## Testing strategy

Update existing text assertions and rendering snapshots, then add focused tests proving:

- Every labeled lifecycle value uses `Process state`.
- Completed free-form output appears under `Result`.
- Failed or cancelled assistant prose appears under `Partial result`, separate from diagnostics.
- Provider termination appears as `Stop reason` in collected results and dashboard details when available.
- Technical failure details appear under `Diagnostics`.
- A completed process with failure language remains process state `completed`.
- A failed process remains process state `failed`.
- No human-facing UI labels process completion as `Agent outcome`.
- Machine-readable `state` fields and enum values are unchanged.
- Compact and expanded rendering remain width-safe.

## Documentation

The README will include a short terminology note explaining that process completion and task success are different. Lifecycle diagrams keep the existing state names but label them process states.

## Success criteria

- Users can distinguish subprocess completion from task success.
- Human-facing terminology is consistent across every surface.
- Free-form prose is not parsed or misrepresented as structured outcome.
- No API, schema, or state-machine compatibility is broken.
