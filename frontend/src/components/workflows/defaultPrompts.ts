import { Lightbulb, Wrench } from 'lucide-react';

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
    prompt:
      'Refactor the code surface described above without changing its observable behavior. ' +
      'Look for duplication, unclear naming, tangled responsibilities, and modules that have ' +
      'drifted past a comfortable size, and tighten them up. Keep public APIs stable, preserve ' +
      'existing tests, and run a type-check before committing. In the commit message, briefly ' +
      'explain what was restructured and why — do not list every file touched.',
  },
  {
    id: 'brainstorm',
    title: 'Brainstorm',
    label: 'Brainstorm',
    icon: Lightbulb,
    prompt:
      'Brainstorm 3–5 distinct approaches to the problem described above. Do not write any ' +
      'production code yet. For each approach, sketch the rough shape of the solution, list the ' +
      'main tradeoffs (complexity, blast radius, ergonomics, performance, reversibility), and ' +
      'flag any unknowns that need investigation before committing to a direction. Write your ' +
      'findings to BRAINSTORM.md at the worktree root, end with a recommendation and the ' +
      'reasoning behind it, and commit the file.',
  },
];
