import type { AgentHarness } from '../harnesses.js';

export type WorkflowStepHarness = AgentHarness;
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;

// 'agent' is a regular AI-agent step (Claude/Pi/Codex spawned in a terminal
// against WORKFLOW_STEP.md). The other kinds are control-flow primitives the
// backend executes directly against the task pipeline:
//   - 'start' moves every Open task to In Progress and runs each one;
//   - 'merge' waits for In Progress to drain, then merges every Ready-to-Merge
//     task into main (handing each via the existing mergeRuns engine);
//   - 'push' waits for Ready-to-Merge to drain, then spawns a push session
//     that pushes the commits already on the branch (its own push-only brief,
//     not the QA-lane button's commit-everything one).
// These step kinds don't use `prompt` / `harness`; the fields are retained on
// disk for schema uniformity but ignored at execution time.
//
// 'test' ("Run tests") is an AGENT step with a fixed brief: it spawns the
// step's harness exactly like 'agent' (same step dir, completion hooks and
// quiescence gate) but hands it RUN_TESTS.md — run the project's tests on the
// main checkout, fix what it can, commit the fixes, write TEST_SUMMARY.md —
// and it never stops the workflow. It ignores `prompt`; `timeoutMinutes`
// bounds it. See workflowRuns/testStep/.
export type WorkflowStepKind = 'agent' | 'start' | 'merge' | 'push' | 'test';

// Run tests step timeout bounds (minutes). Absent = the default. Mirrored by
// the frontend's TestStepRow number input.
export const RUN_TESTS_DEFAULT_TIMEOUT_MINUTES = 60;
export const RUN_TESTS_MIN_TIMEOUT_MINUTES = 5;
export const RUN_TESTS_MAX_TIMEOUT_MINUTES = 720;

export type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  // Legacy per-step 'sequential' | 'parallel' flag. Nothing ever read it (steps
  // always run one after another); the editor no longer writes it and
  // `normalizeSteps` strips it. Optional here only so data and fixtures written
  // before its removal still type-check.
  mode?: 'sequential' | 'parallel';
  harness: WorkflowStepHarness;
  // Pi model ("provider/model") for this step, used only when `harness` is
  // `pi`. Absent = Pi's configured default. See piModels.ts.
  piModel?: string;
  // Defaults to 'agent' (legacy steps that have no `kind` field on disk).
  kind?: WorkflowStepKind;
  // "Frozen" (the editor's snowflake toggle): the step stays in the workflow —
  // prompt and position intact — but the run engine walks straight past it, for
  // every kind. Absent/false = runs normally. See workflowRuns/frozenSteps.ts.
  frozen?: boolean;
  // Pre-run tools for an agent step. Each runs BEFORE the harness spawns and
  // drops its report beside WORKFLOW_STEP.md, surfaced through the brief's
  // `{{tool_reports}}` token. v1: `opengrep` (a SAST scan → OPENGREP_FINDINGS.md).
  // Absent/empty = none. Ignored on control steps. See workflowRuns/stepTools.ts.
  tools?: WorkflowStepTool[];
  // Run tests ('test') steps only: minutes the agent session may run, measured
  // from when its terminal actually spawned (time queued behind the spawn
  // queue / resource governor does not count). Absent = 60. On timeout the
  // session is killed and the step advances with a note — the workflow never
  // stops. Normalized to an integer in [5, 720]; stripped from other kinds.
  timeoutMinutes?: number;
};

export const WORKFLOW_STEP_TOOLS = ['opengrep'] as const;
export type WorkflowStepTool = (typeof WORKFLOW_STEP_TOOLS)[number];

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
