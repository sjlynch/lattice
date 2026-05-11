import { Lightbulb, Merge, Target, Wrench } from 'lucide-react';

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
    id: 'pmf',
    title: 'PMF',
    label: 'PMF',
    icon: Target,
    prompt:
      'Please do a thorough review of this codebase and file all findings as tasks on the Lattice board. Read every source file before writing anything. Check the current status of the task board before beginning, do not create duplicate tasks.\n\n' +
      '## Step 1 — Full exploration\n\n' +
      'Read all source files, the README, any docs/, examples/, or tests/ directories, the build/package config, and all entry-point files. Don\'t skim — read completely. Then check git log for recent commits so you understand what\'s new vs. original, and what\'s actively in flux.\n\n' +
      '## Step 2 — Review across these dimensions\n\n' +
      '### Value proposition and fit\n' +
      '- What problem does this project solve, and for whom? Is that clearly legible from the README and first screen/entry point?\n' +
      '- Does it solve the problem more correctly, more simply, or for a more specific audience than established alternatives — or does it just exist alongside them?\n' +
      '- Is the scope coherent? Does the project try to solve problems that belong in the caller/user, or does it leave core parts of the problem to the caller when it shouldn\'t?\n' +
      '- Who is the intended user, and does every major design decision actually serve that user — or does it serve the implementer?\n\n' +
      '### The happy path\n' +
      '- Walk the primary workflow end to end as the target user would. Does it feel complete and intentional, or does it peter out?\n' +
      '- How quickly can a new user reach a working result with only the README? Where does that onboarding break down?\n' +
      '- What is the "aha moment" — the point where the user sees the value — and is anything in the way of reaching it?\n' +
      '- Does the simplest use case require understanding internals, reading source, or making non-obvious decisions?\n\n' +
      '### Unmet needs and capability gaps\n' +
      'Frame this as a product manager thinking about the first month of real usage:\n' +
      '- What will every user inevitably try to do that they can\'t? What workarounds will they build in week one?\n' +
      '- What is the most likely reason a user abandons this for an alternative after trying it?\n' +
      '- Are there obvious adjacent jobs-to-be-done — things a user needs right before or right after the core workflow — that this doesn\'t address but probably should?\n' +
      '- Does the product handle the second-most-common use case, or only the happy path?\n' +
      '- What does the user have to do *outside* this product to complete their task end to end?\n\n' +
      '### Architecture & hidden bugs\n' +
      'Look for issues that will create user-visible failures or debugging frustration:\n' +
      '- Config, parameters, or inputs that exist on one code path but are silently ignored on another\n' +
      '- State or resources that are never reset on error, abort, or retry\n' +
      '- Silent precedence when mutually exclusive options are both provided\n' +
      '- Errors that are swallowed, logged but not propagated, or returned in a shape the caller can\'t act on\n' +
      '- Anything a user would spend 30+ minutes debugging without a clear error message or warning\n' +
      '- Copy-paste implementations that have already diverged\n\n' +
      '### DX and documentation\n' +
      '- Is the README actually about this project, or is it a placeholder?\n' +
      '- Does the stated dev/install setup work end to end from a clean start?\n' +
      '- Are any public interfaces, config keys, commands, or callbacks confusingly named or underdocumented?\n' +
      '- Are there warnings for obvious misuse or misconfiguration?\n' +
      '- Are limitations, known gaps, or non-obvious behaviors documented anywhere?\n\n' +
      '## Step 3 — File everything to Lattice\n\n' +
      'As you find issues, add them to the Lattice board using the batch API. Group related issues into coherent tasks. For each task include:\n' +
      '- A specific title (not "improve X" but "Gap: no way to export results without writing custom glue code")\n' +
      '- The exact file and line if it\'s a bug\n' +
      '- A concrete fix or acceptance criteria\n' +
      '- Whether it\'s a bug, missing capability, DX improvement, or product/scope issue\n\n' +
      'Don\'t file vague tasks. Every task should be actionable by a developer who has never seen this conversation.',
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
