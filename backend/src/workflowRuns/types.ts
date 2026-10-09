// Wire types of a workflow run: the record (`WorkflowRun`, carried on every
// `/ws/workflow-runs` event and HTTP read), its per-step state and the event
// union. Types only and node-free — the frontend re-exports them through
// backend/src/shared/wireTypes.ts. The registry, emitter and persistence that
// build these stay in state.ts (which re-exports everything here).

import type { Workflow, WorkflowStepHarness, WorkflowStepKind } from '../workflows/types.js';

export type WorkflowRunStatus = 'running' | 'completed' | 'errored' | 'cancelled';

export type WorkflowStepExecution = {
  stepId: string;
  phase: 'pending' | 'spawning' | 'running' | 'completing' | 'completed' | 'skipped' | 'errored' | 'cancelled';
  sessionId?: string;
  stopReceived?: WorkflowRun['stopReceived'];
  error?: string;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  projectPath: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  totalSteps: number;
  // Compatibility anchor: the first runnable member of the current group.
  currentStepIndex: number;
  // New runs persist every member independently; absent on legacy serial runs.
  activeStepIndices?: number[];
  // Exclusive authored boundary, including any frozen members in the group.
  groupEndIndex?: number;
  stepStates?: Record<number, WorkflowStepExecution>;
  harnessOverride?: WorkflowStepHarness;
  // Pi model override for the run, applied to every step when harnessOverride
  // is `pi`. Sibling to harnessOverride (two-field model, see piModels.ts).
  piModelOverride?: string;
  error?: string;
  // The run's task round: every task Open or In Progress when the run started,
  // plus every task its Start step launched or queued. The Merge step waits
  // for these — not runs started by hand mid-workflow — to reach Ready to
  // Merge before merging any.
  // Absent on runs persisted before rounds existed: every task then counts.
  roundTaskIds?: string[];
  definition?: Workflow;
  definitionError?: string;
  stepPhase?: 'pending' | 'spawning' | 'running' | 'completing';
  stepSessionId?: string;
  // Per-step result text, keyed by step index. Today only Run tests ('test')
  // steps write one: their TEST_SUMMARY.md (bounded) plus any Lattice notes
  // (skipped / timed out / could not start) and the post-check of the commits
  // the step made. Persisted in the mirror and carried on every snapshot, so
  // the run strip can show it. See testStep/summary.ts.
  stepSummaries?: Record<number, string>;
  // Checkpoint of the Run tests step in flight (absent otherwise): the HEAD it
  // started from (null = unborn/unreadable) and when its terminal actually
  // spawned — the timeout is measured from that, and a re-adopting backend
  // re-arms it from here. See testStep/.
  testStep?: RunTestsCheckpoint;
  // A Claude Stop-hook completion for this step that the quiescence gate is
  // still holding (stopHookGate.ts) — `at` is the most recent such Stop.
  // Persisted because the gate itself is an in-memory timer: a restart inside
  // its settle window used to lose the completion outright (the hook got its
  // 200, so nothing retries, and the agent is idle and won't Stop again), and
  // the step hung until its timeout — or forever for an agent step. A
  // re-adopting backend re-arms the gate from here. Only meaningful while
  // `stepIndex === currentStepIndex`.
  // `activeAt`: the last time the holding gate saw the session busy (throttled);
  // `busy`: whether it was busy at that checkpoint — a restart then starts the
  // quiet window at boot (agentQuiescence.ts markAgentReadopted).
  stopReceived?: { stepIndex: number; at: number; activeAt?: number; busy?: boolean };
};

export type RunTestsCheckpoint = {
  stepIndex: number;
  startHead: string | null;
  spawnedAt?: number;
};

export type WorkflowRunEvent =
  | { type: 'started'; run: WorkflowRun }
  | { type: 'progress'; run: WorkflowRun }
  | { type: 'completed'; run: WorkflowRun }
  | { type: 'errored'; run: WorkflowRun }
  | { type: 'cancelled'; run: WorkflowRun }
  | {
      type: 'step-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      command: string;
      cwd: string;
      serverId?: string;
      terminalId?: string;
    }
  // Emitted by the Start control step for each Open task it kicks off.
  // The frontend turns each one into a task-tagged terminal tab in the
  // sidebar so the user can watch (and intervene with) the spawned agent.
  // Distinct from `step-spawned` (which is one-per-step) because Start
  // fans out N task agents in a single step and each needs its own tab.
  | {
      type: 'workflow-task-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      taskId: string;
      title: string;
      command: string;
      cwd: string;
      serverId?: string;
      terminalId?: string;
    }
  // Emitted by control-flow steps (Start/Merge/Push) so the frontend can
  // render kind-specific progress in the run strip without spawning a
  // terminal. `current`/`total` semantics differ per kind:
  //   - start: tasks started / total open tasks
  //   - merge: tasks moved to QA / total ready+conflict tasks at step entry
  //   - push: 0..1 / 1 (binary; uses `message` to surface state)
  //   - agent: 0 / 0 + `message` while a pre-run tool (an Opengrep scan) runs
  //     before the harness spawns — the frontend clears it on `step-spawned`
  | {
      type: 'step-control-progress';
      parallel?: boolean;
      runId: string;
      projectPath: string;
      stepIndex: number;
      kind: WorkflowStepKind;
      current: number;
      total: number;
      message?: string;
    };
