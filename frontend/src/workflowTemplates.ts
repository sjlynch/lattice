import type { WorkflowStep } from './api';

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  steps: (Omit<WorkflowStep, 'id' | 'harness'> & Partial<Pick<WorkflowStep, 'harness'>>)[];
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'plan-build-ship',
    name: 'Plan → Build → Ship',
    description:
      'Autonomous pipeline: an agent plans and creates tasks, then Start/Merge/Push drive the entire board through to a remote push without further input.',
    steps: [
      {
        title: 'Plan tasks',
        prompt:
          'Read the project and produce a small batch of Lattice tasks (typically 3–8) that together accomplish the goal described above. Use the create-task.cjs helper. Each task should be self-contained, scoped to one concern, and committable on its own. Do not write code in this step — only create tasks.',
        mode: 'sequential',
        kind: 'agent',
      },
      {
        title: 'Start all open tasks',
        prompt: '',
        mode: 'sequential',
        kind: 'start',
      },
      {
        title: 'Merge all tasks',
        prompt: '',
        mode: 'sequential',
        kind: 'merge',
      },
      {
        title: 'Push to remote',
        prompt: '',
        mode: 'sequential',
        kind: 'push',
      },
    ],
  },
  {
    id: 'refactor-test-document',
    name: 'Refactor → Test → Document',
    description:
      'Three sequential steps: refactor the target code, add or update tests, then update documentation.',
    steps: [
      {
        title: 'Refactor',
        prompt:
          'Identify and refactor the code surface described above. Keep behavior unchanged. Commit your work.',
        mode: 'sequential',
      },
      {
        title: 'Add tests',
        prompt:
          'Building on the refactor that just landed, add or update tests covering the affected code paths. Commit when green.',
        mode: 'sequential',
      },
      {
        title: 'Update docs',
        prompt:
          'Update README/CLAUDE.md/relevant docs to reflect the refactor and any new test patterns. Commit your work.',
        mode: 'sequential',
      },
    ],
  },
  {
    id: 'plan-implement-review',
    name: 'Plan → Implement → Review',
    description:
      'Write a plan, execute it in code, then have the change self-reviewed.',
    steps: [
      {
        title: 'Plan',
        prompt:
          'Read the relevant code and write a step-by-step implementation plan in PLAN.md at the worktree root. Commit it.',
        mode: 'sequential',
      },
      {
        title: 'Implement',
        prompt:
          'Read PLAN.md from the prior step and implement it. Commit your work.',
        mode: 'sequential',
      },
      {
        title: 'Self-review',
        prompt:
          'Review the changes from the prior step. Look for bugs, missing edge cases, dead code. Apply fixes you are confident about and commit.',
        mode: 'sequential',
      },
    ],
  },
  {
    id: 'fix-verify',
    name: 'Fix → Verify',
    description: 'Apply a fix, then verify it with a test or manual check.',
    steps: [
      {
        title: 'Fix',
        prompt: 'Apply the fix described above. Commit when ready.',
        mode: 'sequential',
      },
      {
        title: 'Verify',
        prompt:
          'Verify the fix from the prior step. Add a regression test or run the relevant suite, and commit any verification artifacts.',
        mode: 'sequential',
      },
    ],
  },
];
