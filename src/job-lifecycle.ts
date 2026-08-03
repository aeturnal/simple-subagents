import type { JobState } from "./types.js";

export type JobControlAction = "cancel" | "collect" | "discard";

export interface JobLifecycleFacts {
  readonly settled: boolean;
  readonly inbox: boolean;
}

export type JobControlDecision =
  | { readonly kind: "apply"; readonly nextState: JobState }
  | { readonly kind: "already-applied"; readonly nextState: JobState }
  | { readonly kind: "invalid"; readonly message: string };

type ControlRule = JobState | "same";

type LifecycleRule = JobLifecycleFacts & {
  readonly controls: Readonly<Partial<Record<JobControlAction, ControlRule>>>;
};

const JOB_LIFECYCLE: Readonly<Record<JobState, LifecycleRule>> = {
  queued: { settled: false, inbox: false, controls: { cancel: "cancelled" } },
  running: { settled: false, inbox: false, controls: { cancel: "cancelled" } },
  completed: { settled: true, inbox: true, controls: { collect: "collected", discard: "discarded" } },
  failed: { settled: true, inbox: true, controls: { collect: "collected", discard: "discarded" } },
  cancelled: { settled: true, inbox: true, controls: { cancel: "same", collect: "collected", discard: "discarded" } },
  collected: { settled: true, inbox: false, controls: { collect: "same" } },
  discarded: { settled: true, inbox: false, controls: { discard: "same" } },
};

export function inspectJobState(state: JobState): JobLifecycleFacts {
  const { settled, inbox } = JOB_LIFECYCLE[state];
  return { settled, inbox };
}

export function decideJobControl(state: JobState, action: JobControlAction): JobControlDecision {
  const nextState = JOB_LIFECYCLE[state].controls[action];
  if (nextState === undefined) return { kind: "invalid", message: `Cannot ${action} job in ${state} state` };
  if (nextState === "same") return { kind: "already-applied", nextState: state };
  return { kind: "apply", nextState };
}
