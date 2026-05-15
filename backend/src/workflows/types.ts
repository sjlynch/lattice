import type { AgentHarness } from '../harnesses.js';

export type WorkflowStepMode = 'sequential' | 'parallel';
export type WorkflowStepHarness = AgentHarness;
export type WorkflowRunHarnessOverride = WorkflowStepHarness | null;

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
};

export type Workflow = {
  id: string;
  name: string;
  projectPath: string;
  steps: WorkflowStep[];
  createdAt: number;
};

export type WorkflowSubscriber = (
  projectPath: string,
  workflows: Workflow[],
) => void;
