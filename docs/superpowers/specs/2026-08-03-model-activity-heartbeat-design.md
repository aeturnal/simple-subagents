# Model Activity Heartbeat Design

## Summary

Expose safe model-turn and reasoning activity through the existing subagent progress pipeline. A running job will show that its model is active even when it spends several minutes reasoning after the last tool call.

The extension will publish only fixed labels and timestamps. It will never retain or display reasoning text. Repeated reasoning events will refresh one replaceable model-activity record at most once every five seconds, so long reasoning turns remain visible without growing job history or causing token-rate rendering.

## Goals

- Record model-turn and reasoning activity emitted by child Pi.
- Show the latest model activity in `subagent_status`, `/subagents`, and the live widget.
- Keep long reasoning visibly active when the provider emits continuing reasoning events.
- Never expose reasoning text or other event payload content.
- Keep memory and rendering work bounded.
- Preserve existing tool, partial-answer, lifecycle, collection, and cancellation behavior.

## Non-goals

- Adding a structured current-phase field to `Job` or public status.
- Detecting, classifying, or automatically cancelling stalled jobs.
- Adding execution deadlines or changing `subagent_wait` timeouts.
- Changing process completion or cancellation behavior.
- Changing child extension loading.
- Summarizing or displaying model reasoning.
- Adding configuration for heartbeat frequency.

## Public behavior

The process runner translates documented child Pi events into extension-owned activity labels:

| Child Pi event | Public activity |
| --- | --- |
| `turn_start` | `Model turn started` |
| `message_update.assistantMessageEvent.type === "thinking_start"` | `Model reasoning` |
| Continuing `thinking_delta` events | Refresh `Model reasoning` when at least five seconds have elapsed since the last reasoning activity accepted by the runner |
| `message_update.assistantMessageEvent.type === "thinking_end"` | `Model reasoning finished` |
| `turn_end` | `Model turn finished` |

Every public label is a fixed string owned by `simple-subagents`. Reasoning content, partial reasoning, provider metadata, and other event payload values are not copied into progress or status output.

A representative long turn appears over time as:

```text
0s   Model turn started
1s   Model reasoning
6s   Model reasoning
11s  Model reasoning
16s  Model reasoning
18s  Model reasoning finished
19s  Model turn finished
```

Only the latest model activity is retained. Each accepted update replaces the older model activity and moves the new record to the chronological end of the job's progress list.

## Data model

Extend `ProgressItem.type` with `"model"`:

```ts
export interface ProgressItem {
  type: "tool" | "text" | "diagnostic" | "model";
  text: string;
  timestamp: number;
  truncation?: TextTruncation;
}
```

The `text` of a model progress item is always one of the fixed public labels. The existing progress callback remains the process-runner boundary; no second callback or mutable phase field is introduced.

Extend status activity with a `model` kind so presentation code can distinguish model activity from diagnostics without parsing its text:

```ts
interface StatusActivity {
  timestamp: number;
  kind: "assistant" | "tool" | "diagnostic" | "model";
  summary: string;
}
```

## Process runner

`PiProcessRunner.reduceEvent` recognizes top-level `turn_start` and `turn_end` events plus nested assistant message events for `thinking_start`, `thinking_delta`, and `thinking_end`.

Add an injectable `now` clock to `PiProcessRunnerDependencies`, defaulting to `Date.now`, and use it for new model activity timestamps. This makes the five-second boundary deterministic in tests. Existing progress timestamps may use the same clock without changing their meaning.

The runner keeps one private `lastReasoningActivityAt` value for the active process:

- `thinking_start` always emits `Model reasoning` and records its timestamp.
- `thinking_delta` emits only when no reasoning activity has been recorded or `now - lastReasoningActivityAt >= 5000`.
- An ignored delta does not update `lastReasoningActivityAt`.
- `thinking_end` always emits `Model reasoning finished`, regardless of throttling, then clears the reasoning heartbeat timestamp.
- Turn boundaries always emit their fixed activity and reset reasoning heartbeat state as a defensive boundary.

The heartbeat is event-driven. It adds no interval or timeout. If a provider emits `thinking_start` but no continuing deltas, the extension does not invent activity that it cannot observe.

Unknown events and malformed event shapes continue through the existing ignore and diagnostic behavior. Model activity handling must not throw when optional nested fields are absent.

## Job manager

`JobManager.addProgress` treats `model` similarly to the existing replaceable partial-answer record:

1. Remove every older `model` item.
2. Append the accepted new item.
3. Apply the existing non-text history bound without allowing model heartbeats to accumulate.
4. Notify subscribers once for each accepted model update.

The newest model activity therefore stays chronologically correct. Existing tool and diagnostic history and the latest partial answer remain available.

## Presentation

`projectJobStatus` maps `model` progress to a `StatusActivity` with kind `model` and its fixed bounded label.

All three requested surfaces already consume the shared status projection or manager snapshots:

- `subagent_status` includes model events in `Recent activity`.
- `/subagents` includes model events in its recent activity section.
- The live widget uses the latest model event for the running job's activity child line.

No surface receives raw reasoning content. Existing terminal sanitization and byte/grapheme bounds remain in force even though model labels are fixed constants.

## Rendering and update bounds

The process runner accepts at most one continuing reasoning heartbeat per five-second window. The job manager stores at most one model record. This bounds both retained memory and manager notifications independently of reasoning token rate.

The live widget's existing animation behavior remains unchanged: while a job is running, progress snapshots are presented on its normal animation frames rather than adding a new render interval. The dashboard and status tool continue using their existing update paths.

## Error and privacy handling

- Never copy `thinking_delta`, `thinking_start`, or `thinking_end` content into a public record.
- Never include a raw malformed event sample in model activity.
- Use extension-owned constants for every model label.
- Ignore unsupported model event types.
- Keep existing bounded protocol diagnostics for parser failures.
- Add no timer requiring cleanup.
- Do not change process settlement, cancellation, or job lifecycle semantics.

## Testing strategy

Follow test-driven development.

### Process runner

Use the fake child process and an injected clock to test:

- `turn_start` emits `Model turn started`.
- `thinking_start` emits `Model reasoning`.
- Reasoning text and hostile terminal content never appear in emitted progress.
- Deltas before five seconds are ignored.
- A delta at exactly five seconds refreshes `Model reasoning`.
- Later accepted deltas use the previous accepted heartbeat as their boundary.
- `thinking_end` emits `Model reasoning finished` even inside the throttle window.
- `turn_end` emits `Model turn finished` and resets reasoning state.
- Split JSON input is reduced correctly.
- Missing nested event fields do not throw or create model activity.

### Job manager

Test that:

- Repeated model updates retain only the newest model record.
- Replacement appends the newest record in chronological order.
- Tool and diagnostic history remains present.
- Latest partial-answer retention remains unchanged.
- Model updates do not consume the bounded non-model history over time.

### Status and interfaces

Test that:

- `projectJobStatus` returns model activity with kind `model`.
- `subagent_status` renders the fixed model activity and its age.
- `/subagents` renders model activity in recent activity.
- The live widget displays model activity for a running job.
- Hostile reasoning content supplied in an event is absent from every rendered surface.

### Regression verification

Run:

```sh
npx tsx --test test/process-runner.test.ts test/job-manager.test.ts test/job-status.test.ts test/tools.test.ts test/dashboard.test.ts test/live-widget.test.ts
npm test
npm run typecheck
npm pack --dry-run
```

Run LSP diagnostics for every edited TypeScript file and pi-lens diagnostics before completion.

No paid provider call is required. The tests feed documented Pi JSON event shapes into the existing fake child process.

## Documentation

Update `README.md` to explain that recent activity includes safe model-turn and reasoning heartbeats, that reasoning text is never captured, and that the heartbeat depends on events emitted by the selected provider and model.

## Success criteria

- A model that emits continuing reasoning events no longer appears idle merely because its last tool call is old.
- `subagent_status`, `/subagents`, and the live widget show the same latest model activity.
- No reasoning content is retained or rendered.
- At most one continuing reasoning update is accepted every five seconds.
- At most one model activity record is retained per job.
- Existing tool, answer, lifecycle, wait, collection, and cancellation behavior remains unchanged.
