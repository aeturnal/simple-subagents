import assert from "node:assert/strict";
import test from "node:test";
import type { JobState } from "../src/types.js";

const states: JobState[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "collected",
  "discarded",
];

const loadLifecycle = async () => {
  try {
    return await import("../src/job-lifecycle.js");
  } catch (error) {
    assert.fail(`job lifecycle module is unavailable: ${String(error)}`);
  }
};

test("inspects settled and inbox facts for every job state", async () => {
  const { inspectJobState } = await loadLifecycle();
  const expected = {
    queued: { settled: false, inbox: false },
    running: { settled: false, inbox: false },
    completed: { settled: true, inbox: true },
    failed: { settled: true, inbox: true },
    cancelled: { settled: true, inbox: true },
    collected: { settled: true, inbox: false },
    discarded: { settled: true, inbox: false },
  } as const;

  for (const state of states) assert.deepEqual(inspectJobState(state), expected[state]);
});

test("decides every valid and idempotent control action", async () => {
  const { decideJobControl } = await loadLifecycle();
  const expected = [
    ["queued", "cancel", { kind: "apply", nextState: "cancelled" }],
    ["running", "cancel", { kind: "apply", nextState: "cancelled" }],
    ["cancelled", "cancel", { kind: "already-applied", nextState: "cancelled" }],
    ["completed", "collect", { kind: "apply", nextState: "collected" }],
    ["failed", "collect", { kind: "apply", nextState: "collected" }],
    ["cancelled", "collect", { kind: "apply", nextState: "collected" }],
    ["collected", "collect", { kind: "already-applied", nextState: "collected" }],
    ["completed", "discard", { kind: "apply", nextState: "discarded" }],
    ["failed", "discard", { kind: "apply", nextState: "discarded" }],
    ["cancelled", "discard", { kind: "apply", nextState: "discarded" }],
    ["discarded", "discard", { kind: "already-applied", nextState: "discarded" }],
  ] as const;

  for (const [state, action, decision] of expected) {
    assert.deepEqual(decideJobControl(state, action), decision);
  }
});

test("returns the existing diagnostic for every invalid control action", async () => {
  const { decideJobControl } = await loadLifecycle();
  const actions = ["cancel", "collect", "discard"] as const;
  const valid = new Set([
    "queued:cancel",
    "running:cancel",
    "cancelled:cancel",
    "completed:collect",
    "failed:collect",
    "cancelled:collect",
    "collected:collect",
    "completed:discard",
    "failed:discard",
    "cancelled:discard",
    "discarded:discard",
  ]);

  for (const state of states) {
    for (const action of actions) {
      if (valid.has(`${state}:${action}`)) continue;
      assert.deepEqual(decideJobControl(state, action), {
        kind: "invalid",
        message: `Cannot ${action} job in ${state} state`,
      });
    }
  }
});
