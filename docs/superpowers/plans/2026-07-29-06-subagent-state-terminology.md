# Clear Subagent State Terminology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every labeled lifecycle value read `Process state`, reserve `Result` and `Partial result` for subagent prose, and expose `Stop reason` and `Diagnostics` consistently without changing machine behavior.

**Architecture:** Keep `Job.state`, `JobState`, and all manager transitions as the sole machine lifecycle source. Change only the existing pure collected-result formatter and the text emitted by tools, notifications, and dashboard details; each surface derives labels directly from the existing `Job` fields and treats completed output separately from failed or cancelled assistant prose.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi extension/TUI APIs 0.82.x, Node's test runner through `tsx`.

## Global Constraints

- Start from the released Plans 01–05 state; preserve stale-safe notification filtering, `subagent_wait`, `subagent_agents`, launch/report model metadata, and bounded rich status.
- Process states remain exactly `queued`, `running`, `completed`, `failed`, `cancelled`, `collected`, and `discarded`.
- `completed` means the subprocess exited successfully with a usable final response under existing manager rules; it does not claim that the requested task was accomplished.
- `Result` is free-form final output from a completed process; do not parse or classify its prose.
- `Partial result` is assistant prose captured from a failed or cancelled process and remains separate from technical diagnostics.
- Provider termination information is labeled exactly `Stop reason`.
- Technical failure information is labeled exactly `Diagnostics`.
- When a lifecycle label appears, use exactly `Process state`, never `Status` or `Agent outcome`.
- Compact rows such as `job-2 running` may remain unlabeled when their context is unambiguous.
- Keep `job.state`, `ToolDetails.jobs[].state`, `JobState`, serialized detail keys, input schemas, custom message types, and state transitions unchanged.
- Do not add a derived `processState` field or any structured semantic outcome.
- Do not change process-runner success/failure detection or reclassify a process from answer prose.
- Continue handling absent output, diagnostics, model, and stop reason without throwing.
- Do not suppress substantive diagnostic content, and preserve width-safe compact and expanded rendering.
- Add no runtime dependency or configuration.

---

## File Structure

- `src/output.ts` — own terminology and section separation for collected results.
- `test/json-output.test.ts` — prove collected metadata, result semantics, partial-result separation, stop reason, diagnostics, and byte caps.
- `src/tools.ts` — label single-job model output and expanded tool details while preserving compact rows and machine details.
- `test/tools.test.ts` — prove tool text, machine compatibility, expanded rendering, notification wording, and width safety.
- `src/index.ts` — update completion notification text only; retain transition detection, debounce, message type, and details.
- `src/dashboard.ts` — render process state, stop reason, result/partial-result sections, and technical diagnostics in job details.
- `test/dashboard.test.ts` — prove dashboard terminology, optional stop reason, semantic separation, and narrow-width safety.
- `README.md` — document process states separately from answer meaning and show the canonical labels.

---

### Task 1: Separate collected results from process diagnostics

**Files:**
- Modify: `test/json-output.test.ts:141-248`
- Modify: `src/output.ts:33-96`

**Interfaces:**
- Consumes: unchanged `Job.state`, `Job.output`, `Job.progress`, `Job.stopReason`, stderr/error/malformed-event fields, and capture metadata.
- Produces: unchanged `formatCollectedResult(job: Job): string` and `capCollectedPayload(content: string): string`.
- Produces: metadata line `- Process state: <JobState>` and optional `- Stop reason: <value>`.
- Produces: `## Result` only for completed/other non-failure snapshots; `## Partial result` plus `## Diagnostics` for failed or cancelled snapshots.
- Preserves: the 50 KiB UTF-8 cap and all existing machine fields.

- [ ] **Step 1: Replace the completed-result assertion with canonical terminology and failure-language coverage**

In `test/json-output.test.ts`, replace `formats a completed result deterministically` with:

```ts
test("formats completed failure-language as a completed process result", () => {
  assert.equal(
    formatCollectedResult(job({
      output: "I could not complete the task because credentials are unavailable.",
      stopReason: "stop",
    })),
    "# Subagent result: job-42\n\n" +
      "- Process state: completed\n" +
      "- Agent: reviewer\n" +
      "- Access: read-only\n" +
      "- Task: Review token handling\n" +
      "- Stop reason: stop\n" +
      "- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n" +
      "## Result\n\n" +
      "I could not complete the task because credentials are unavailable.",
  );
});
```

This fixture deliberately contains task-failure language while retaining `Process state: completed`.

- [ ] **Step 2: Replace the exact failed-result assertion with partial-result and diagnostics sections**

Replace `formats failed results with output, stderr, and truncation diagnostics` with:

```ts
test("separates failed assistant prose, stop reason, and technical diagnostics", () => {
  assert.equal(
    formatCollectedResult(job({
      state: "failed",
      output: "Captured assistant output",
      stderr: "process exited 1",
      errorMessage: "Pi process exited before producing a final answer.",
      stopReason: "error",
      progress: [{ type: "text", text: "Latest assistant text", timestamp: 1 }],
      malformedEventCount: 1,
      malformedEventSamples: ["bad event"],
    })),
    "# Subagent result: job-42\n\n" +
      "- Process state: failed\n" +
      "- Agent: reviewer\n" +
      "- Access: read-only\n" +
      "- Task: Review token handling\n" +
      "- Stop reason: error\n" +
      "- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n" +
      "## Partial result\n\n" +
      "Latest assistant text:\nLatest assistant text\n\n" +
      "Captured output:\nCaptured assistant output\n\n" +
      "## Diagnostics\n\n" +
      "Stderr:\nprocess exited 1\n\n" +
      "Error:\nPi process exited before producing a final answer.\n\n" +
      "Malformed events: 1\nMalformed samples:\n- bad event",
  );
});

test("uses captured output as a cancelled partial result when no progress text exists", () => {
  const formatted = formatCollectedResult(job({
    state: "cancelled",
    output: "Work completed before cancellation",
    stopReason: undefined,
  }));

  assert.match(formatted, /- Process state: cancelled/);
  assert.doesNotMatch(formatted, /Stop reason:/);
  assert.match(formatted, /## Partial result\n\nCaptured output:\nWork completed before cancellation/);
  assert.match(formatted, /## Diagnostics/);
  assert.doesNotMatch(formatted, /## Result(?:\n|$)/);
  assert.doesNotMatch(formatted, /(?:Status|Agent outcome):/);
});
```

- [ ] **Step 3: Update capture and byte-domain regression fixtures exactly**

For the test named `keeps capture notices and latest partial output in failed payloads`, replace its expected-value loop with:

```ts
  for (const expected of [
    "Partial result capture truncated: retained 51200 of 70000 bytes",
    "Stderr capture truncated: retained 51200 of 75000 bytes",
    "Error capture truncated: retained 51200 of 80000 bytes",
    "Latest partial result capture truncated: retained 51200 of 90000 bytes",
    "## Partial result",
    "Latest assistant text:\nlatest partial",
    "Captured output:\noutput ",
    "## Diagnostics",
  ]) assert.match(formatted, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
```

In `caps failed diagnostics without duplicating output and reports formatted-payload counts`, replace `completeContent` and the old output-count assertion with:

```ts
  const completeContent = `# Subagent result: job-42\n\n## Capture limits\nPartial result capture truncated: retained 60000 of 100000 bytes.\n\n- Process state: failed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n## Partial result\n\nCaptured output:\n${output}\n\n## Diagnostics\n\nStderr:\n${stderr}\n\nError:\nnone\n\nMalformed events: 0\nMalformed samples:\nnone`;

  assert.equal(formatted.split("Captured output:\n").length - 1, 1);
```

Keep that test's byte-limit, UTF-8 replacement-character, final notice, original-byte, and retained-byte assertions unchanged.

In `reports final cap counts in the formatted-payload domain after upstream output truncation`, replace `completeContent` with:

```ts
  const completeContent = `# Subagent result: job-42\n\n## Capture limits\nPartial result capture truncated: retained 500 of 1000 bytes.\n\n- Process state: failed\n- Agent: reviewer\n- Access: read-only\n- Task: Review token handling\n- Usage: input 0, output 0, cache read 0, cache write 0, cost 0, turns 0\n\n## Partial result\n\nCaptured output:\npartial\n\n## Diagnostics\n\nStderr:\n${stderr}\n\nError:\nnone\n\nMalformed events: 0\nMalformed samples:\nnone`;
```

Keep the test named `keeps capture notices before oversized completed task and result bodies` unchanged: completed output still uses the `Output capture` notice and `## Result` section.

- [ ] **Step 4: Run the formatter tests to verify RED**

Run:

```bash
npx tsx --test test/json-output.test.ts
```

Expected: FAIL because collected metadata still contains `Status`, failed output is still inside `Diagnostics`, `Partial result` is absent, and stop reason is not rendered.

- [ ] **Step 5: Implement the minimal collected-result sectioning**

In `src/output.ts`, replace `formatCollectedResult` with:

```ts
export const formatCollectedResult = (job: Job): string => {
  const access = job.request.writeAccess ? "write" : "read-only";
  const isFailure = job.state === "failed" || job.state === "cancelled";
  const metadata = [
    `- Process state: ${job.state}`,
    `- Agent: ${job.profile.name}`,
    `- Access: ${access}`,
    `- Task: ${job.request.task}`,
    ...(job.launchModel ? [`- Launch model: ${job.launchModel}`] : []),
    ...(thinkingSelection(job) ? [`- Launch thinking: ${thinkingSelection(job)}`] : []),
    ...(job.model ? [`- Reported model: ${job.model}`] : []),
    ...(job.stopReason ? [`- Stop reason: ${job.stopReason}`] : []),
    usageLine(job),
  ];
  const latestPartial = [...job.progress].reverse().find((item) => item.type === "text");
  const captureNotices = [
    captureNotice(isFailure ? "Partial result" : "Output", job.outputTruncation ?? job.truncation),
    captureNotice("Stderr", job.stderrTruncation),
    captureNotice("Error", job.errorTruncation),
    captureNotice("Latest partial result", latestPartial?.truncation),
  ].filter((notice): notice is string => notice !== undefined);
  const sections = [
    `# Subagent result: ${job.id}`,
    ...(captureNotices.length ? [`## Capture limits\n${captureNotices.join("\n")}`] : []),
    metadata.join("\n"),
  ];

  if (isFailure) {
    const partialResult = [
      ...(latestPartial ? [`Latest assistant text:\n${latestPartial.text}`] : []),
      ...(job.output ? [`Captured output:\n${job.output}`] : []),
    ].join("\n\n") || "none";
    const samples = job.malformedEventSamples?.length
      ? job.malformedEventSamples.map((sample) => `- ${sample}`).join("\n")
      : "none";
    sections.push(`## Partial result\n\n${partialResult}`);
    sections.push([
      "## Diagnostics",
      `Stderr:\n${job.stderr}`,
      `Error:\n${job.errorMessage ?? "none"}`,
      `Malformed events: ${job.malformedEventCount}\nMalformed samples:\n${samples}`,
    ].join("\n\n"));
  } else {
    sections.push(`## Result\n\n${job.output}`);
  }

  return capCollectedPayload(sections.join("\n\n"));
};
```

Do not modify `Job`, `JobState`, `JobManager`, or `PiProcessRunner`.

- [ ] **Step 6: Run formatter tests to verify GREEN**

Run:

```bash
npx tsx --test test/json-output.test.ts
```

Expected: PASS, including all existing 50 KiB and UTF-8 assertions with their updated complete-content fixtures.

- [ ] **Step 7: Commit the collected-result terminology**

```bash
git add src/output.ts test/json-output.test.ts
git commit -m "feat: clarify collected subagent result terminology"
```

---

### Task 2: Label richer single-job status without changing its DTO

**Files:**
- Modify: `test/status.test.ts`
- Modify: `src/status.ts`

**Interfaces:**
- Consumes: the `PublicJobStatus` and bounded formatter introduced by Plan 05.
- Produces: unchanged `formatSingleJobStatus(status, now): string`, with the first two lines `<id>` and `Process state: <state>`.
- Preserves: `PublicJobStatus.state`, aggregate compact status lines, progress privacy, launch/reported model lines, and the 50 KiB cap.

- [ ] **Step 1: Write the failing formatter assertion**

In the rich running-status test in `test/status.test.ts`, replace the old `job-4: running` expectation with:

```ts
assert.match(runningText, /^job-4\nProcess state: running$/m);
assert.doesNotMatch(runningText, /(?:Status|Agent outcome):/);
```

Add machine-compatibility coverage:

```ts
assert.equal(running.state, "running");
assert.equal(Object.hasOwn(running, "processState"), false);
```

Keep the existing timing, launch/reported model, usage, progress, privacy, and byte-bound assertions.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
npx tsx --test --test-name-pattern="formats rich running" test/status.test.ts
```

Expected: FAIL because the formatter still emits `job-4: running`.

- [ ] **Step 3: Change only the lifecycle label in the formatter**

In `formatSingleJobStatus()` in `src/status.ts`, replace its first array entry with:

```ts
status.id,
`Process state: ${status.state}`,
```

Do not change `formatStatusList()`, DTO fields, model labels, or activity formatting.

- [ ] **Step 4: Run status tests and typecheck**

```bash
npx tsx --test test/status.test.ts
npm run typecheck
```

Expected: PASS with aggregate rows still compact and unlabeled.

- [ ] **Step 5: Commit rich-status terminology**

```bash
git add src/status.ts test/status.test.ts
git commit -m "feat: label subagent process state in status"
```

---

### Task 3: Label expanded start and control job details

**Files:**
- Modify: `test/tools.test.ts`
- Modify: `src/tools.ts`

**Interfaces:**
- Consumes: the specialized wait and rich-status branches, the separate profile-discovery renderer, and standard `details.jobs` rendering.
- Produces: expanded standard job blocks containing `Process state`, `Task`, and the existing launch metadata.
- Preserves: compact rows, wait/profile/status rendering, tool schemas, and machine-readable `job.state`.

- [ ] **Step 1: Add failing expanded-render assertions**

In the existing tool-renderer test, retain compact assertions and add:

```ts
const expandedStart = render("subagent_start", started, true);
assert.match(expandedStart, /job-1\n  Process state: running\n  Task: one/);
assert.match(expandedStart, /Launch model:/);

const expandedDiscard = render("subagent_control", discarded, true);
assert.match(expandedDiscard, /job-2\n  Process state: discarded\n  Task: two/);
assert.equal(discarded.details.jobs[0]?.state, "discarded");
assert.equal(Object.hasOwn(discarded.details.jobs[0] ?? {}, "processState"), false);
```

Also assert the wait and status branches plus the separate profile-discovery renderer still produce their existing specialized output.

- [ ] **Step 2: Run the focused renderer test and verify RED**

```bash
npx tsx --test --test-name-pattern="tool renderers preserve" test/tools.test.ts
```

Expected: FAIL because standard expanded job blocks do not label process state.

- [ ] **Step 3: Extend the existing standard-job detail helper**

Update the existing launch-detail helper used by start/control rendering so it begins with:

```ts
const expandedJob = (job: Job): string => [
  job.id,
  `  Process state: ${job.state}`,
  `  Task: ${job.request.task}`,
  `  Launch model: ${job.launchModel ?? "Pi default"}`,
  `  Launch thinking: ${launchThinking(job)}`,
].join("\n");
```

Use `expandedJob` only in the standard job-rendering branch. Keep the earlier wait-result and rich-status branches plus the separate profile-discovery renderer unchanged. Collection continues rendering its collected `content`.

- [ ] **Step 4: Run tool tests and typecheck**

```bash
npx tsx --test test/tools.test.ts
npm run typecheck
```

Expected: PASS; compact rows and every existing specialized renderer remain unchanged.

- [ ] **Step 5: Commit expanded tool terminology**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "feat: label expanded subagent job state"
```

---

### Task 4: Clarify completion notification wording

**Files:**
- Modify: `test/tools.test.ts:405-466`
- Modify: `src/index.ts:26-68`

**Interfaces:**
- Consumes: Plan 01's flush-time-filtered terminal entries `[jobId, Job["state"]]` collected by `installCompletionNotifier`.
- Produces: unchanged `installCompletionNotifier(pi: ExtensionAPI, manager: JobManager, timers?: TimerDependencies): () => void`.
- Produces: unchanged `simple-subagents-ready` message type, `details: { jobIds: string[] }`, 100 ms debounce, and delivery options.
- Preserves: stale filtering, action-neutral wording, delivery-error containment, shutdown guards, notification timing, output secrecy, and explicit collection behavior.

- [ ] **Step 1: Require explicit process-state wording in the existing notification test**

In `completion notices debounce real terminal transitions at 100 ms, including cancellation, without leaking output`, replace the three loose state matches with:

```ts
  assert.equal(
    pi.messages[0]?.content,
    "Jobs may be ready: " +
      "job-1 (Process state: completed), " +
      "job-2 (Process state: failed), " +
      "job-3 (Process state: cancelled).\n" +
      "Check their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.",
  );
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /(?:Status|Agent outcome):/);
  assert.doesNotMatch(pi.messages[0]?.content ?? "", /ask the user/i);
```

Keep the existing assertions for filtered `jobIds`, no secret output, 100 ms debounce, no duplicate notice, and `{ deliverAs: "followUp", triggerTurn: true }`.

- [ ] **Step 2: Run the focused notification test to verify RED**

Run:

```bash
npx tsx --test --test-name-pattern="completion notices debounce" test/tools.test.ts
```

Expected: FAIL because the stale-safe message renders unlabeled process-state values.

- [ ] **Step 3: Change notification copy without changing notifier logic**

In `src/index.ts`, replace only the summary mapping inside Plan 01's guarded `flush`; keep its existing `try/catch` and stale-safe second line:

```ts
const summary = `Jobs may be ready: ${ready
  .map(([id, state]) => `${id} (Process state: ${state})`)
  .join(", ")}.`;
```

The existing message content remains:

```ts
`${summary}\nCheck their current state. Collect any still-uncollected results needed by the active task; otherwise no action is required.`
```

Do not alter flush-time `manager.get()` filtering, `terminal`, `previous`, `pending`, `notified`, delivery-error containment, active/shutdown guards, debounce timing, or message details.

- [ ] **Step 4: Run notification and full tool tests to verify GREEN**

Run:

```bash
npx tsx --test --test-name-pattern="completion notices debounce|completion notifier cleanup" test/tools.test.ts
npx tsx --test test/tools.test.ts
```

Expected: both commands PASS, and notification content contains no job output.

- [ ] **Step 5: Commit notification terminology**

```bash
git add src/index.ts test/tools.test.ts
git commit -m "feat: distinguish process completion in notifications"
```

---

### Task 5: Structure dashboard details with canonical labels

**Files:**
- Modify: `test/dashboard.test.ts:186-268,401-424`
- Modify: `src/dashboard.ts:177-224`

**Interfaces:**
- Consumes: unchanged `Job.state`, `Job.stopReason`, launch/reported model fields, result/progress fields, diagnostics, capture metadata, and usage.
- Produces: unchanged `SubagentsDashboard` component API.
- Produces: detail metadata `Process state: <state>` and `Stop reason: <value|not reported>` while retaining `Launch model`, `Launch thinking`, and `Reported model`.
- Produces: a `Result` section for completed jobs, a `Partial result` section for failed/cancelled jobs, and a `Diagnostics` section for technical fields.
- Preserves: unlabeled compact rows, key handling, ANSI-aware truncation, and all manager actions.

- [ ] **Step 1: Add completed and failed detail terminology tests**

Add after `dashboard detail shows the latest partial assistant text progress`:

```ts
test("dashboard separates completed process state, result, stop reason, and diagnostics", () => {
  const view = dashboard(new FakeManager([job("job-1", "completed", {
    output: "I could not finish because credentials are unavailable.",
    stopReason: "stop",
  })]));

  view.handleInput?.("\r");
  const detail = render(view, 160);
  for (const expected of [
    "Process state: completed",
    "Stop reason: stop",
    "Result",
    "I could not finish because credentials are unavailable.",
    "Diagnostics",
  ]) assert.match(detail, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(detail, /(?:Status|Agent outcome):/);
  assert.doesNotMatch(detail, /Partial result/);
  view.dispose();
});

test("dashboard groups failed assistant prose under Partial result outside Diagnostics", () => {
  const view = dashboard(new FakeManager([job("job-1", "failed", {
    output: "Captured assistant output",
    stopReason: "error",
    progress: [{ type: "text", text: "Latest assistant text", timestamp: 2_500 }],
    stderr: "process stderr",
    errorMessage: "process error",
  })]));

  view.handleInput?.("\r");
  const detail = render(view, 160);
  assert.match(detail, /Process state: failed/);
  assert.match(detail, /Stop reason: error/);
  assert.match(detail, /Partial result\nLatest assistant text · Captured assistant output/);
  assert.match(detail, /Diagnostics\nPartial result capture:/);
  assert.match(detail, /Stderr: process stderr/);
  assert.match(detail, /Error: process error/);
  assert.ok(detail.indexOf("Partial result\n") < detail.indexOf("Diagnostics\n"));
  assert.doesNotMatch(detail, /(?:Status|Agent outcome):/);
  view.dispose();
});
```

- [ ] **Step 2: Update absent-value and collection assertions**

In `dashboard details always render every required label with absent-value placeholders`, replace the required-label loop with:

```ts
  for (const label of [
    "Process state:", "Task:", "Profile:", "Access:", "Launch model:", "Launch thinking:", "Reported model:", "Created:", "Started:",
    "Finished:", "Progress:", "Stop reason:", "Diagnostics", "Output capture:",
    "Stderr:", "Stderr capture:", "Error:", "Error capture:",
    "Latest partial result capture:", "Malformed:", "Usage:", "Truncated:",
  ]) assert.ok(detail.includes(label), `missing ${label}`);
  assert.match(detail, /Process state: queued/);
  assert.match(detail, /Stop reason: not reported/);
```

In `dashboard collection formats completed, failed, and cancelled terminal snapshots before delivery`, replace the `Status` assertion with:

```ts
    assert.ok(pi.messages[0]?.message.content.includes(`Process state: ${state}`));
    assert.doesNotMatch(pi.messages[0]?.message.content, /(?:Status|Agent outcome):/);
    if (state === "completed") assert.match(pi.messages[0]?.message.content, /## Result/);
    else assert.match(pi.messages[0]?.message.content, /## Partial result/);
```

Keep the existing model, usage, delivery, and manager-transition assertions.

- [ ] **Step 3: Extend the existing width test to cover the new detail labels**

In `dashboard preserves ANSI-aware width bounds for compact and detailed output`, after toggling details, add:

```ts
    assert.match(plain(lines.join("\n")), /Process state:/);
    assert.match(plain(lines.join("\n")), /Diagnostics/);
```

The existing loop over widths `30`, `60`, and `100` remains the width-safety assertion.

- [ ] **Step 4: Run dashboard tests to verify RED**

Run:

```bash
npx tsx --test test/dashboard.test.ts
```

Expected: FAIL because dashboard details currently use `Output`, omit process state and stop reason, and do not have result or diagnostics section headings.

- [ ] **Step 5: Replace flat output fields with result and diagnostics sections**

In `src/dashboard.ts`, replace `detail(job, width)` with:

```ts
  private detail(job: Job, width: number): string[] {
    const lines = [this.options.theme.bold(`DETAIL ${job.id}`)];
    const wrap = (label: string, value: string): void => {
      const available = Math.max(1, width - label.length);
      const wrapped = wrapTextWithAnsi(value, available);
      lines.push(`${label}${wrapped.shift() ?? ""}`);
      lines.push(...wrapped.map((part) => " ".repeat(label.length) + part));
    };
    const latestPartial = [...job.progress].reverse().find((item) => item.type === "text");
    const isFailure = job.state === "failed" || job.state === "cancelled";
    const partialResult = [...new Set([
      latestPartial?.text,
      job.output || undefined,
    ].filter((value): value is string => value !== undefined))].join(" · ") || "none";

    wrap("Process state: ", job.state);
    wrap("Task: ", job.request.task);
    wrap("Profile: ", job.profile.name);
    wrap("Access: ", job.request.writeAccess ? "write" : "read-only");
    const thinkingSource = job.launchThinkingSource === "job" ? "job override"
      : job.launchThinkingSource === "parent" ? "parent session"
        : job.launchThinkingSource === "legacy" ? "legacy profile/parent behavior"
          : "model or Pi default";
    wrap("Launch model: ", job.launchModel ?? "Pi default");
    wrap("Launch thinking: ", job.launchThinkingLevel ? `${job.launchThinkingLevel} (${thinkingSource})` : thinkingSource);
    wrap("Reported model: ", job.model ?? "not reported");
    wrap("Created: ", new Date(job.createdAt).toISOString());
    wrap("Started: ", job.startedAt ? new Date(job.startedAt).toISOString() : "not started");
    wrap("Finished: ", job.finishedAt ? new Date(job.finishedAt).toISOString() : "not finished");
    wrap("Progress: ", job.progress.slice(-3).map((item) => item.text).join(" · ") || "none");
    wrap("Stop reason: ", job.stopReason || "not reported");
    wrap("Usage: ", `input ${job.usage.input}, output ${job.usage.output}, cache ${job.usage.cacheRead + job.usage.cacheWrite}, ${job.usage.turns} turns`);

    if (job.state === "completed") {
      lines.push(this.options.theme.bold("Result"));
      wrap("", job.output || "none");
    } else if (isFailure) {
      lines.push(this.options.theme.bold("Partial result"));
      wrap("", partialResult);
    }

    lines.push(this.options.theme.bold("Diagnostics"));
    const outputTruncation = job.outputTruncation ?? job.truncation;
    wrap(isFailure ? "Partial result capture: " : "Output capture: ", outputTruncation
      ? `${outputTruncation.keptBytes} of ${outputTruncation.originalBytes} bytes retained`
      : "not truncated");
    wrap("Stderr: ", job.stderr || "none");
    wrap("Stderr capture: ", job.stderrTruncation
      ? `${job.stderrTruncation.keptBytes} of ${job.stderrTruncation.originalBytes} bytes retained`
      : "not truncated");
    wrap("Error: ", job.errorMessage || "none");
    wrap("Error capture: ", job.errorTruncation
      ? `${job.errorTruncation.keptBytes} of ${job.errorTruncation.originalBytes} bytes retained`
      : "not truncated");
    wrap("Latest partial result capture: ", latestPartial?.truncation
      ? `${latestPartial.truncation.keptBytes} of ${latestPartial.truncation.originalBytes} bytes retained`
      : "not truncated");
    wrap("Malformed: ", `${job.malformedEventCount} (${job.malformedEventSamples?.join(", ") || "none"})`);
    wrap("Truncated: ", job.truncation
      ? `${job.truncation.keptBytes} of ${job.truncation.originalBytes} bytes retained`
      : "not truncated");
    return lines.map((item) => truncateToWidth(item, width));
  }
```

Do not change `row()`: its unlabeled compact `job-id state` form is intentionally retained.

- [ ] **Step 6: Run dashboard tests and type checking to verify GREEN**

Run:

```bash
npx tsx --test test/dashboard.test.ts
npm run typecheck
```

Expected: both commands PASS; all rendered lines remain within widths 30, 60, and 100.

- [ ] **Step 7: Commit dashboard terminology**

```bash
git add src/dashboard.ts test/dashboard.test.ts
git commit -m "feat: separate dashboard process state and results"
```

---

### Task 6: Document process-state and result semantics

**Files:**
- Modify: `README.md:28-56`

**Interfaces:**
- Consumes: the seven unchanged `JobState` values and the labels implemented in Tasks 1–5.
- Produces: a user-facing terminology note and one completed-process example.
- Preserves: installation, profile, access, limits, and memory-only lifecycle guidance.

- [ ] **Step 1: Add the terminology contract to the lifecycle section**

Under `## Limits and lifecycle`, after the first paragraph, insert:

```md
### Process states and results

The extension reports **Process state** separately from the meaning of a subagent's answer. Process states are `queued`, `running`, `completed`, `failed`, `cancelled`, `collected`, and `discarded`. A `completed` process exited successfully with a usable answer; it does not guarantee that the requested task succeeded. The extension does not parse answer prose into a semantic outcome.

A completed process's free-form answer appears under **Result**. Assistant prose retained from a failed or cancelled process appears under **Partial result**, separately from technical **Diagnostics**. Provider termination information appears as **Stop reason** when available.

For example, a process can report:

```text
Process state: completed
Stop reason: stop

## Result
I could not complete the task because the required credentials are unavailable.
```

That process remains `completed`; the answer explains that the requested task was blocked.
```

- [ ] **Step 2: Verify documentation uses the contract and retains lifecycle guidance**

Run:

```bash
node - <<'NODE'
const fs = require("node:fs");
const readme = fs.readFileSync("README.md", "utf8");
for (const text of [
  "Process state: completed",
  "## Result",
  "Partial result",
  "Diagnostics",
  "Stop reason",
  "queued`, `running`, `completed`, `failed`, `cancelled`, `collected`, and `discarded",
  "The inbox is memory-only",
]) {
  if (!readme.includes(text)) throw new Error(`README missing: ${text}`);
}
if (/Agent outcome:/.test(readme)) throw new Error("README uses forbidden Agent outcome label");
NODE
```

Expected: exit code 0 with no output.

- [ ] **Step 3: Commit the documentation**

```bash
git add README.md
git commit -m "docs: explain subagent process state terminology"
```

---

### Task 7: Verify terminology coverage and machine compatibility

**Files:**
- Verify: `src/output.ts`
- Verify: `src/status.ts`
- Verify: `src/tools.ts`
- Verify: `src/index.ts`
- Verify: `src/dashboard.ts`
- Verify: `src/types.ts`
- Verify: `src/job-manager.ts`
- Verify: `test/json-output.test.ts`
- Verify: `test/status.test.ts`
- Verify: `test/tools.test.ts`
- Verify: `test/dashboard.test.ts`
- Verify: `README.md`

**Interfaces:**
- Consumes: all behavior implemented in Tasks 1-6.
- Produces: verification evidence only; no new API or source file.
- Preserves: `JobState`, `Job.state`, state transitions, schemas, and process result classification.

- [ ] **Step 1: Run the focused terminology suites**

```bash
npx tsx --test test/json-output.test.ts test/status.test.ts test/tools.test.ts test/dashboard.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run existing state-machine tests unchanged**

```bash
npx tsx --test test/job-manager.test.ts
```

Expected: PASS, including `maps process results to completed and failed states`; no manager or runner change is required.

- [ ] **Step 3: Scan human-facing source and documentation for forbidden lifecycle labels**

Run:

```bash
node - <<'NODE'
const fs = require("node:fs");
for (const file of ["src/output.ts", "src/status.ts", "src/tools.ts", "src/index.ts", "src/dashboard.ts", "README.md"]) {
  const text = fs.readFileSync(file, "utf8");
  for (const pattern of [/Status:/g, /Agent outcome:/g]) {
    const matches = text.match(pattern);
    if (matches) throw new Error(`${file} contains ${matches.length} forbidden ${pattern.source} label(s)`);
  }
}
NODE
```

Expected: exit code 0 with no output. The tool name and label `subagent_status` / `Subagent Status` may remain because they name an inspection operation, not a lifecycle value label.

- [ ] **Step 4: Verify no duplicate machine field was introduced**

Run:

```bash
node - <<'NODE'
const fs = require("node:fs");
for (const file of ["src/types.ts", "src/job-manager.ts", "src/tools.ts"]) {
  const text = fs.readFileSync(file, "utf8");
  if (/\bprocessState\b/.test(text)) throw new Error(`${file} introduces processState`);
}
const types = fs.readFileSync("src/types.ts", "utf8");
const expected = 'export type JobState = "queued" | "running" | "completed" | "failed" | "cancelled" | "collected" | "discarded";';
if (!types.includes(expected)) throw new Error("JobState values changed");
NODE
```

Expected: exit code 0 with no output.

- [ ] **Step 5: Run full verification**

```bash
npm test
npm run typecheck
```

Expected: all tests PASS (the real-Pi integration remains skipped unless `SIMPLE_SUBAGENTS_INTEGRATION=1`) and TypeScript reports no errors.

- [ ] **Step 6: Confirm only the planned files changed**

```bash
git status --short
git diff --stat HEAD~6..HEAD
```

Expected: the six implementation commits touch only `src/output.ts`, `src/status.ts`, `src/tools.ts`, `src/index.ts`, `src/dashboard.ts`, `test/json-output.test.ts`, `test/status.test.ts`, `test/tools.test.ts`, `test/dashboard.test.ts`, and `README.md`, plus this plan if it is committed separately by the plan author.
