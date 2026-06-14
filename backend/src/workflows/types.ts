import type { AgentHarness } from '../harnesses.js';

export type WorkflowStepMode = 'sequential' | 'parallel';
export type WorkflowStepHarness = AgentHarness;
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;

// 'agent' is a regular AI-agent step (Claude/Pi/Codex spawned in a terminal
// against WORKFLOW_STEP.md). The other kinds are control-flow primitives the
// backend executes directly against the task pipeline:
//   - 'start' moves every Open task to In Progress and runs each one;
//   - 'merge' waits for In Progress to drain, then merges every Ready-to-Merge
//     task into main (handing each via the existing mergeRuns engine);
//   - 'push' waits for Ready-to-Merge to drain, then spawns a push session
//     (same code path as the Task Board cloud icon).
// These step kinds don't use `prompt` / `harness`; the fields are retained on
// disk for schema uniformity but ignored at execution time.
export type WorkflowStepKind = 'agent' | 'start' | 'merge' | 'push';

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  // 'parallel' is reserved for the future fan-out-per-file executor; the
  // current run engine treats every step as sequential. Schema-only support
  // is intentional — UI can author parallel steps so the data is ready when
  // the executor lands.
  mode: WorkflowStepMode;
  harness: WorkflowStepHarness;
  // Defaults to 'agent' (legacy steps that have no `kind` field on disk).
  kind?: WorkflowStepKind;
};

// A user-defined variable whose `value` is substituted into any step prompt
// that references it as `{{name}}` before the prompt is handed to an agent.
// Every workflow always carries at least the built-in `user_instructions`
// variable (see USER_INSTRUCTIONS_VAR / ensureUserInstructions).
export type WorkflowVariable = {
  id: string;
  name: string;
  value: string;
};

export type Workflow = {
  id: string;
  name: string;
  projectPath: string;
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  createdAt: number;
};

export type WorkflowSubscriber = (
  projectPath: string,
  workflows: Workflow[],
) => void;
