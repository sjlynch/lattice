import {
  BookText,
  Bug,
  FlaskConical,
  Lightbulb,
  Merge,
  ShieldAlert,
  ShieldCheck,
  Target,
  Wrench,
} from 'lucide-react';
import type { WorkflowStepTool } from '../../api';
import refactorPrompt from './prompts/refactor.md?raw';
import opengrepPrompt from './prompts/opengrep.md?raw';
import combineTasksPrompt from './prompts/combine-tasks.md?raw';
import pmfPrompt from './prompts/pmf.md?raw';
import brainstormPrompt from './prompts/brainstorm.md?raw';
import bugCatcherPrompt from './prompts/bug-catcher.md?raw';
import securityPrompt from './prompts/security.md?raw';
import testCoveragePrompt from './prompts/test-coverage.md?raw';
import documentationPrompt from './prompts/documentation.md?raw';

export type DefaultPrompt = {
  id: string;
  title: string;
  label: string;
  icon: typeof Wrench;
  prompt: string;
  // Pre-run tools the seeded step carries (`WorkflowStep.tools`) — the
  // Opengrep chip sets `['opengrep']` so the scan runs before the agent starts.
  tools?: WorkflowStepTool[];
  // One line of benchmark evidence shown above the prompt in the chip's tooltip.
  hint?: string;
};

// Quick-insert prompts surfaced as chips at the bottom of the editor. Each
// click appends a new step seeded with the prompt body. Keep these prompts
// self-sufficient — they may be the only step a user runs.
export const DEFAULT_PROMPTS: DefaultPrompt[] = [
  {
    id: 'refactor',
    title: 'Refactor',
    label: 'Refactor',
    icon: Wrench,
    prompt: refactorPrompt,
  },
  {
    id: 'combine-tasks',
    title: 'Combine Tasks',
    label: 'Combine Tasks',
    icon: Merge,
    prompt: combineTasksPrompt,
  },
  {
    id: 'pmf',
    title: 'PMF',
    label: 'PMF',
    icon: Target,
    prompt: pmfPrompt,
  },
  {
    id: 'bug-catcher',
    title: 'Bug Catcher',
    label: 'Bug Catcher',
    icon: Bug,
    prompt: bugCatcherPrompt,
    hint:
      'On a whole repo, one step finds few bugs: of 30 real bugs planted in Lattice, sol and Astra found 1 and Opus 7. ' +
      'Split the step across the repo (the Split button) to cover it all: 10 areas found 13–15 with sol, 16 areas 17.',
  },
  {
    id: 'test-coverage',
    title: 'Test Coverage',
    label: 'Test Coverage',
    icon: FlaskConical,
    prompt: testCoveragePrompt,
  },
  {
    id: 'security',
    title: 'Security',
    label: 'Security',
    icon: ShieldAlert,
    prompt: securityPrompt,
  },
  {
    // Seeds a step with the Opengrep pre-run tool ON: Lattice scans the
    // project before the agent starts and the prompt triages the digest.
    id: 'opengrep',
    title: 'Opengrep Triage',
    label: 'Opengrep',
    icon: ShieldCheck,
    prompt: opengrepPrompt,
    tools: ['opengrep'],
  },
  {
    id: 'brainstorm',
    title: 'Brainstorm',
    label: 'Brainstorm',
    icon: Lightbulb,
    prompt: brainstormPrompt,
  },
  {
    id: 'documentation',
    title: 'Documentation',
    label: 'Documentation',
    icon: BookText,
    prompt: documentationPrompt,
  },
];
