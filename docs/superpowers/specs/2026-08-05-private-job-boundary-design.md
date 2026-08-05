# Private Job Boundary Design

## Goal

Keep uncollected subagent data in memory by preventing complete `Job` objects and malformed protocol text from entering persisted tool-result details.

This is a focused privacy patch. It does not redesign job capture, parsing, lifecycle management, or the dashboard.

## Public tool details

`JobManager` continues to own complete in-memory `Job` records. Tool responses must not expose those records directly.

Add a small public job-detail type and one projection function in `src/tools.ts`. The public detail contains only fields required by the existing tool renderers:

- Job ID
- Job state
- A bounded task preview where the start renderer needs it
- Bounded launch model information
- Launch thinking level and source

The projection excludes:

- Profile objects and system prompts
- Complete request objects
- Captured output and partial output
- Progress history
- Stderr and error bodies
- Usage data
- Malformed protocol data
- Capture metadata that renderers do not need

The shared tool-response helper projects every supplied `Job` before placing it in `details.jobs`. Direct status responses use the same projection. This covers start, status, cancel, collect, and discard without changing `JobManager` or its internal snapshots.

`subagent_wait` remains unchanged because it already returns only job IDs and states.

Existing tool layouts and wording remain unchanged. Render helpers consume the new public detail instead of `Job`.

## Malformed protocol handling

`JsonLineParser` continues counting malformed records but stops retaining their text. A malformed record follows this flow:

```text
Malformed line -> increment count -> discard text
```

Remove malformed sample storage and propagation from:

- `JsonLineParser`
- `ProcessResult`
- `Job`
- `JobManager`
- Collected failure diagnostics
- Dashboard full details

Collection and dashboard views continue showing the malformed-event count. They do not show sample text or replacement payload metadata.

Normal parsing, process failure behavior, output capture, and collection limits remain unchanged.

## Persistence boundary

New tool-result details contain only projected public job data. Complete in-memory jobs remain available to the manager and dashboard during the current session.

Explicit collection still places the selected subagent answer in tool-result content and therefore in the conversation. The answer must not also be duplicated in `details`.

This change does not rewrite old session files. Previously persisted full job details may remain in existing sessions.

## Error handling

Malformed input still increments `malformedEventCount`, preserving a useful diagnostic signal. Existing job states, process errors, cancellation behavior, and collection behavior do not change.

No redaction framework, parser metadata format, new capture module, or fallback sample storage is introduced.

## Tests

Add regression coverage that verifies:

- Start, status, cancel, discard, and collect details contain only approved public fields.
- Profile prompts, captured output, stderr, error bodies, progress, usage, and malformed text do not appear in serialized details.
- Explicitly collected output remains present in tool content but absent from details.
- A malformed reasoning-shaped record containing a unique secret marker cannot appear in collection or dashboard output.
- Malformed-event counts still propagate through the parser, process result, job, collection diagnostics, and dashboard.
- Existing compact and expanded tool rendering remains unchanged.

Run the complete test suite and TypeScript typecheck after implementation.

## Non-goals

- Large streamed JSON record handling
- Section-aware collection budgets
- A general job-capture or privacy module
- Job lifecycle refactoring
- New malformed-event structural metadata
- Rewriting or cleaning existing session files
