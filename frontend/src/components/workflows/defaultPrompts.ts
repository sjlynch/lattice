import { Lightbulb, Merge, Wrench } from 'lucide-react';

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
      'Analyze the codebase and look for opportunities to refactor the code so that it is easier ' +
      'for LLMs to navigate and understand. Break down large source files that handle too many ' +
      'concerns into focused clean submodules, untangle dependencies, simplify long functions or ' +
      'classes, replace magic numbers with variables, remove duplication and also make sure that ' +
      'we update claude.md files as necessary, adding new ones within subfolders if context would ' +
      'be crucially helpful to LLMs, but keeping all claude.md files succinct. It is important ' +
      'that the refactored code does not change the original code\'s observable behavior.\n\n' +
      'Keep public APIs stable, preserve existing tests, and run a type-check before committing. ' +
      'In the commit message, briefly explain what was restructured and why — do not list every ' +
      'file touched.\n\n' +
      'For each refactoring opportunity, add a task to the Lattice task board for this active ' +
      'project.',
  },
  {
    id: 'combine-tasks',
    title: 'Combine Tasks',
    label: 'Combine Tasks',
    icon: Merge,
    prompt:
      'Analyze the Lattice task board for this active project and identify tasks that heavily ' +
      'overlap or are likely to produce merge conflicts when run in parallel — same files, same ' +
      'functions, related concerns, or descriptions that imply the same underlying change. The ' +
      'goal is to reduce merge conflicts during the merge-all run by collapsing redundancy ' +
      'before any worktrees are spawned.\n\n' +
      'For each cluster you find, combine the tasks into a single new task whose description ' +
      'covers all of the original work, then delete the originals. Preserve any nuance from the ' +
      'merged descriptions; do not silently drop requirements. Leave tasks that are genuinely ' +
      'independent alone — combining unrelated work is worse than the conflicts it would avoid.\n\n' +
      'Use the Lattice task board API for this active project to read, create, and delete tasks.',
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
