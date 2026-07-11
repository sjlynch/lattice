import { BookText, Bug, FlaskConical, Lightbulb, Merge, ShieldAlert, Target, Wrench } from 'lucide-react';
import refactorPrompt from './prompts/refactor.md?raw';
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
