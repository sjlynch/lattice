import type { WorkflowStep } from './api';
import opengrepPrompt from './components/workflows/prompts/opengrep.md?raw';

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
  // Everything below is a pure chain of agent (planning) steps — exactly what a
  // user gets by clicking quick-add chips in a row. No template bundles a
  // start/merge/push step: landing work is an explicit action the user adds, not
  // something a preset does on their behalf. (`plan-build-ship` above is the one
  // deliberate exception — running the board to a push IS its whole point, and
  // it says so in its name and description.)
  {
    id: 'refactor-test-document',
    name: 'Refactor → Test → Document',
    description:
      'Three planning passes over the same code surface: file refactor tasks, then test tasks, then documentation tasks. Add Start/Merge steps between them if you want each round to land before the next is planned.',
    steps: [
      {
        title: 'Refactor',
        prompt:
          'Identify the refactoring opportunities in the code surface described above and file one Lattice task each. Every task must keep observable behavior unchanged, stay scoped to one file or module so it can land without conflicting with its siblings, and name the exact paths involved. Do not refactor anything yourself and do not commit.',
        mode: 'sequential',
        kind: 'agent',
      },
      {
        title: 'Add tests',
        prompt:
          'Identify the test gaps around the code surface described above and file one Lattice task each, naming the exact test file and the specific behavior to cover. Prefer extending an existing test file over creating a new one, and skip anything an existing test or an existing task on the board already covers. Do not write tests yourself and do not commit.',
        mode: 'sequential',
        kind: 'agent',
      },
      {
        title: 'Update docs',
        prompt:
          'Identify the documentation that is stale or missing for the code surface described above — the README, any CLAUDE.md/AGENTS.md navigation files, and any docs folder — and file one Lattice task each, naming the exact file and the specific claim to fix. Do not edit documentation yourself and do not commit.',
        mode: 'sequential',
        kind: 'agent',
      },
    ],
  },
  {
    id: 'plan-refine-review',
    name: 'Plan → Refine → Review',
    description:
      'Break the goal into tasks, tighten the resulting board so the tasks land cleanly, then review the code they will touch for problems worth filing too.',
    steps: [
      {
        title: 'Plan',
        prompt:
          'Read the relevant code and break the goal described above into Lattice tasks — one per self-contained, committable change, in the order they should land. Name the exact files each task touches and give it concrete acceptance criteria; the agent that picks it up has none of this context. Do not write code yourself.',
        mode: 'sequential',
        kind: 'agent',
      },
      {
        title: 'Refine',
        prompt:
          'Re-read the tasks now on the board for this project. Split any that are too large to land as a single commit, combine any that would edit the same lines and therefore conflict when they merge in parallel, and make sure every one names the exact files it touches and has concrete acceptance criteria. Update or delete tasks through the API as needed. Do not write code yourself.',
        mode: 'sequential',
        kind: 'agent',
      },
      {
        title: 'Review',
        prompt:
          'Review the code these tasks will touch, reading the recent git history and diffs. Look for bugs, missing edge cases, and dead code that the planned work would otherwise carry forward, and file one Lattice task per finding with the exact file, the failure mode, and a suggested fix. Do not apply fixes yourself.',
        mode: 'sequential',
        kind: 'agent',
      },
    ],
  },
  {
    id: 'fix-verify',
    name: 'Fix → Verify',
    description:
      'File the fix as a task, then file the regression test that proves it.',
    steps: [
      {
        title: 'Fix',
        prompt:
          'Diagnose the problem described above and file it as a Lattice task (or a few, if it splits cleanly). Include the exact file and code path, the failure mode, the expected behavior, and the fix you have in mind. Do not apply the fix yourself.',
        mode: 'sequential',
        kind: 'agent',
      },
      {
        title: 'Verify',
        prompt:
          'File a Lattice task for the regression test that would catch the bug diagnosed in the previous step — naming the exact test file, the case to add, and how it fails without the fix. Read the task the previous step filed so the two line up. Do not write the test yourself.',
        mode: 'sequential',
        kind: 'agent',
      },
    ],
  },
  {
    id: 'security-review-opengrep',
    name: 'Security review (Opengrep)',
    description:
      'Runs an Opengrep static-analysis scan before the step and has the agent triage the findings into tasks — one per rule group, fingerprint-tagged so re-runs never duplicate. Needs Opengrep installed in Settings → Tools.',
    steps: [
      {
        title: 'Opengrep Triage',
        // Same body as the "Opengrep" quick-add chip (one source of truth).
        prompt: opengrepPrompt,
        mode: 'sequential',
        kind: 'agent',
        tools: ['opengrep'],
      },
    ],
  },
];
