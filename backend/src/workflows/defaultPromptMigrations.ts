// Migrations for Lattice's OWN built-in workflow-step prompts.
//
// A workflow is saved as a plain copy of whatever prompt text the quick-add chip
// or the template picker produced, so a shipped prompt that was later reworded
// lives on verbatim in every workflows.json that already used it. This module is
// how a shipped rewording reaches those saved copies.
//
// Why it exists (2026-08): several built-in prompts told the agent to do the work
// and commit it ("bring the docs up to a high standard … commit your work"), which
// contradicts WORKFLOW_STEP.md's planner-only contract. The agent has to resolve
// that contradiction, and at least once resolved it the wrong way and committed
// code from a workflow step. Rewording the shipped prompt fixed new workflows;
// this fixes the saved ones.
//
// Matching is a PREFIX match on the legacy body, not equality, because a saved
// prompt is the body plus whatever the editor appended — `{{user_instructions}}`
// always, and the "## Active project tailoring" block for project-aware chips.
// The suffix is preserved as-is. A prompt the user edited by hand no longer
// matches any legacy body and is therefore never touched.
//
// GENERATED-ish: the legacy strings were lifted byte-exact from git history.
// When you reword a built-in prompt, append the OLD body to that entry's
// `legacy` array (newest first) and update `current`.
// `__tests__/defaultPromptMigrations.test.ts` pins `current` against the
// frontend prompt files so the two copies cannot drift.

import type { Workflow, WorkflowStep } from './types.js';

export type DefaultPromptMigration = {
  id: string;
  // Previously-shipped bodies of this prompt, newest first. Trailing whitespace
  // is already trimmed so the prefix test lines up with what the editor stores.
  legacy: string[];
  current: string;
};

export const DEFAULT_PROMPT_MIGRATIONS: DefaultPromptMigration[] = [
  {
    id: "quick-add:refactor",
    // Told the agent to refactor + commit; the task-filing line came last.
    legacy: [
      [
        "Analyze the codebase and look for opportunities to refactor the code so that it is easier for LLMs to navigate and understand. Break down large source files that handle too many concerns into focused clean submodules, untangle dependencies, simplify long functions or classes, replace magic numbers with variables, remove duplication and also make sure that we update claude.md files as necessary, adding new ones within subfolders if context would be crucially helpful to LLMs, but keeping all claude.md files succinct. It is important that the refactored code does not change the original code's observable behavior.",
        "",
        "Keep public APIs stable, preserve existing tests, and run a type-check before committing. In the commit message, briefly explain what was restructured and why — do not list every file touched.",
        "",
        "For each refactoring opportunity, add a task to the Lattice task board for this active project.",
      ].join('\n'),
      "Refactor the code surface described above without changing its observable behavior. Look for duplication, unclear naming, tangled responsibilities, and modules that have drifted past a comfortable size, and tighten them up. Keep public APIs stable, preserve existing tests, and run a type-check before committing. In the commit message, briefly explain what was restructured and why — do not list every file touched.",
    ],
    current: [
      "Analyze the codebase for opportunities to refactor the code so that it is easier for LLMs to navigate and understand, and file each opportunity as a task on the Lattice board for this active project. Do not refactor anything yourself and do not commit — the board entries are your output.",
      "",
      "Look for large source files that handle too many concerns and should be broken into focused clean submodules, tangled dependencies, long functions or classes that should be simplified, magic numbers that should become named variables, and duplication that should be removed. Also look for `CLAUDE.md` files that need updating, and subfolders where adding one would be crucially helpful to LLMs — while keeping every `CLAUDE.md` succinct.",
      "",
      "Every task you file must state that the refactor may not change the original code's observable behavior, must keep public APIs stable, must preserve existing tests, and must type-check before it is committed. Scope each task to one file or one module so it can land without conflicting with its siblings, name the exact paths involved, and do not file duplicates.",
    ].join('\n'),
  },
  {
    id: "quick-add:brainstorm",
    // Told the agent to write BRAINSTORM.md into the repo and commit it.
    legacy: [
      "Brainstorm 3–5 distinct approaches to the problem described above. Do not write any production code yet. For each approach, sketch the rough shape of the solution, list the main tradeoffs (complexity, blast radius, ergonomics, performance, reversibility), and flag any unknowns that need investigation before committing to a direction. Write your findings to BRAINSTORM.md at the worktree root, end with a recommendation and the reasoning behind it, and commit the file.",
    ],
    current: [
      "Brainstorm 3–5 distinct approaches to the problem described above, then file the outcome as tasks on the Lattice board for this active project. Do not write code, do not write a findings file into the repo, and do not commit anything — the board entries are your output.",
      "",
      "For each approach, work out the rough shape of the solution, the main tradeoffs (complexity, blast radius, ergonomics, performance, reversibility), and any unknowns that need investigation before committing to a direction.",
      "",
      "Then settle on a recommendation and file it:",
      "",
      "- One task per implementation step of the recommended approach, each scoped so it is self-contained and committable on its own, naming the exact files involved.",
      "- Put the recommendation and the reasoning behind it in the first task's description, together with the alternatives you rejected and why — the agent that picks the task up has none of this context.",
      "- One task per unknown that has to be resolved first, if any, stating exactly what question the investigation must answer.",
      "",
      "Check the board first and do not file duplicates.",
    ].join('\n'),
  },
  {
    id: "quick-add:documentation",
    // Told the agent to write the docs itself and commit — the reported incident.
    legacy: [
      [
        "Survey this project and bring its documentation up to a high standard. Stay language- and framework-agnostic: work with whatever stack, tooling, and conventions the project already uses, follow the patterns you find rather than imposing new ones, and make no assumptions about the language.",
        "",
        "Read the existing documentation first — the top-level README, any `CLAUDE.md`/`AGENTS.md` files, and any docs folders — so you extend and correct what's there instead of duplicating it. Then push the docs to a genuinely useful state:",
        "",
        "- **Project overview.** Make sure the top-level README (or its equivalent) clearly explains what the project is, how to build/run/test it, and how the code is laid out — enough for a newcomer or an agent to get oriented quickly.",
        "- **`CLAUDE.md` navigation files.** Add or update `CLAUDE.md` files in the directories where local context would crucially help a coding agent: the ones with non-obvious structure, important invariants, or easy-to-miss conventions. Keep every `CLAUDE.md` **compact** — it is loaded into an agent's limited context on every session, so cut filler ruthlessly and never restate what the code already makes obvious — yet **rich with the key details that actually trip up LLMs and coding harnesses**: the gotchas and footguns, invariants that must not be broken, non-obvious file relationships, where a given concern lives, and the exact build/test/type-check commands. Prefer a short, dense doc over a long, wandering one.",
        "- **Keep them current.** Treat stale documentation as a bug. Fix or remove anything that no longer matches the code so each `CLAUDE.md` reflects the directory as it is now, not as it once was.",
        "- **Pair every `CLAUDE.md` with an `AGENTS.md`.** So that every agent harness reads the same guidance, each directory that has a `CLAUDE.md` must also have an `AGENTS.md` beside it — and that `AGENTS.md` should do nothing but point at its sibling `CLAUDE.md` (for example: `See CLAUDE.md in this directory for agent instructions.`). Do not copy the content across the two files; the `AGENTS.md` is only a pointer so the `CLAUDE.md` stays the single source of truth. Create any missing `AGENTS.md` for existing `CLAUDE.md` files, and whenever you add a new `CLAUDE.md`, add its paired `AGENTS.md` too.",
        "",
        "When you're done, commit your work with a concise message describing what documentation you added or updated.",
      ].join('\n'),
    ],
    current: [
      "Survey this project's documentation and file every gap you find as a task on the Lattice board for this active project. You are planning the documentation work, not performing it — do not create, edit, or delete any documentation file yourself, and do not commit anything.",
      "",
      "Stay language- and framework-agnostic: work with whatever stack, tooling, and conventions the project already uses, follow the patterns you find rather than imposing new ones, and make no assumptions about the language.",
      "",
      "Read the existing documentation first — the top-level README, any `CLAUDE.md`/`AGENTS.md` files, and any docs folders — so the tasks you file extend and correct what is there instead of duplicating it. Then file tasks covering what it would take to reach a genuinely useful state:",
      "",
      "- **Project overview.** If the top-level README (or its equivalent) does not clearly explain what the project is, how to build/run/test it, and how the code is laid out — enough for a newcomer or an agent to get oriented quickly — file a task naming exactly what is missing.",
      "- **`CLAUDE.md` navigation files.** File tasks to add or update `CLAUDE.md` files in the directories where local context would crucially help a coding agent: the ones with non-obvious structure, important invariants, or easy-to-miss conventions. Spell out in each task that the file must stay **compact** — it is loaded into an agent's limited context on every session, so filler is cut ruthlessly and nothing the code already makes obvious is restated — yet **rich with the key details that actually trip up LLMs and coding harnesses**: the gotchas and footguns, invariants that must not be broken, non-obvious file relationships, where a given concern lives, and the exact build/test/type-check commands. A short, dense doc beats a long, wandering one.",
      "- **Keep them current.** Treat stale documentation as a bug. File a task for anything that no longer matches the code, naming the file and the specific claim that has gone stale.",
      "- **Pair every `CLAUDE.md` with an `AGENTS.md`.** So that every agent harness reads the same guidance, each directory that has a `CLAUDE.md` must also have an `AGENTS.md` beside it — and that `AGENTS.md` should do nothing but point at its sibling `CLAUDE.md` (for example: `See CLAUDE.md in this directory for agent instructions.`). The content is never copied across the two files; the `AGENTS.md` is only a pointer so the `CLAUDE.md` stays the single source of truth. File a task for any missing `AGENTS.md`, and have every task that adds a new `CLAUDE.md` add its paired `AGENTS.md` too.",
      "",
      "Scope each task to one directory or one document so it can land on its own without conflicting with its siblings, and name the exact paths involved. Check the board first and do not file duplicates. If the documentation is already in good shape, file nothing and say so.",
    ].join('\n'),
  },
  {
    id: "template-step:refactor",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Identify and refactor the code surface described above. Keep behavior unchanged. Commit your work.",
    ],
    current: "Identify the refactoring opportunities in the code surface described above and file one Lattice task each. Every task must keep observable behavior unchanged, stay scoped to one file or module so it can land without conflicting with its siblings, and name the exact paths involved. Do not refactor anything yourself and do not commit.",
  },
  {
    id: "template-step:add-tests",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Building on the refactor that just landed, add or update tests covering the affected code paths. Commit when green.",
    ],
    current: "Identify the test gaps around the code surface described above and file one Lattice task each, naming the exact test file and the specific behavior to cover. Prefer extending an existing test file over creating a new one, and skip anything an existing test or an existing task on the board already covers. Do not write tests yourself and do not commit.",
  },
  {
    id: "template-step:update-docs",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Update README/CLAUDE.md/relevant docs to reflect the refactor and any new test patterns. Commit your work.",
    ],
    current: "Identify the documentation that is stale or missing for the code surface described above — the README, any CLAUDE.md/AGENTS.md navigation files, and any docs folder — and file one Lattice task each, naming the exact file and the specific claim to fix. Do not edit documentation yourself and do not commit.",
  },
  {
    id: "template-step:plan",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Read the relevant code and write a step-by-step implementation plan in PLAN.md at the worktree root. Commit it.",
    ],
    current: "Read the relevant code and break the goal described above into Lattice tasks — one per self-contained, committable change, in the order they should land. Name the exact files each task touches and give it concrete acceptance criteria; the agent that picks it up has none of this context. Do not write code yourself.",
  },
  {
    id: "template-step:implement",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Read PLAN.md from the prior step and implement it. Commit your work.",
    ],
    current: "Re-read the tasks now on the board for this project. Split any that are too large to land as a single commit, combine any that would edit the same lines and therefore conflict when they merge in parallel, and make sure every one names the exact files it touches and has concrete acceptance criteria. Update or delete tasks through the API as needed. Do not write code yourself.",
  },
  {
    id: "template-step:self-review",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Review the changes from the prior step. Look for bugs, missing edge cases, dead code. Apply fixes you are confident about and commit.",
    ],
    current: "Review the code these tasks will touch, reading the recent git history and diffs. Look for bugs, missing edge cases, and dead code that the planned work would otherwise carry forward, and file one Lattice task per finding with the exact file, the failure mode, and a suggested fix. Do not apply fixes yourself.",
  },
  {
    id: "template-step:fix",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Apply the fix described above. Commit when ready.",
    ],
    current: "Diagnose the problem described above and file it as a Lattice task (or a few, if it splits cleanly). Include the exact file and code path, the failure mode, the expected behavior, and the fix you have in mind. Do not apply the fix yourself.",
  },
  {
    id: "template-step:verify",
    // Built-in workflow-template step that told the agent to implement + commit.
    legacy: [
      "Verify the fix from the prior step. Add a regression test or run the relevant suite, and commit any verification artifacts.",
    ],
    current: "File a Lattice task for the regression test that would catch the bug diagnosed in the previous step — naming the exact test file, the case to add, and how it fails without the fix. Read the task the previous step filed so the two line up. Do not write the test yourself.",
  },
];

// Line-ending normalization only — the comparison and the rewritten prefix both
// use LF, so a prompt stored with CRLF still matches (and comes back LF-only,
// which is what the editor and the renderer both produce anyway).
function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Replace a stale built-in prompt body with its current wording, preserving
// whatever the editor appended after it. Returns the prompt unchanged when it
// is already current, was hand-edited, or was never a built-in.
export function migrateDefaultPromptText(prompt: string): string {
  if (!prompt) return prompt;
  const text = normalizeEol(prompt);
  for (const migration of DEFAULT_PROMPT_MIGRATIONS) {
    if (text.startsWith(migration.current)) return prompt;
    for (const legacy of migration.legacy) {
      if (!text.startsWith(legacy)) continue;
      return migration.current + text.slice(legacy.length);
    }
  }
  return prompt;
}

export function migrateWorkflowStepPrompts(steps: WorkflowStep[]): {
  steps: WorkflowStep[];
  changed: boolean;
} {
  let changed = false;
  const next = steps.map((step) => {
    const prompt = migrateDefaultPromptText(step.prompt);
    if (prompt === step.prompt) return step;
    changed = true;
    return { ...step, prompt };
  });
  return { steps: changed ? next : steps, changed };
}

export function migrateWorkflowDefaultPrompts(workflows: Workflow[]): {
  workflows: Workflow[];
  changed: boolean;
} {
  let changed = false;
  const next = workflows.map((workflow) => {
    const result = migrateWorkflowStepPrompts(workflow.steps);
    if (!result.changed) return workflow;
    changed = true;
    return { ...workflow, steps: result.steps };
  });
  return { workflows: changed ? next : workflows, changed };
}
