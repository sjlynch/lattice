// What a task agent may run to verify its work — the `taskAgentTypecheck`
// setting rendered for the agent.
//
// Task agents run NO verification by default: no test suite, e2e tests, builds,
// dependency installs for testing, or type-checks. Eight agents each running a
// big monorepo's full suite plus a cold `tsc -b` in its own fresh worktree was
// most of the machine's CPU (2026-09); a workflow's Run tests step verifies the
// merged result once instead. The pressure to test never came from Lattice's
// own briefs — it came from repo CLAUDE.md / AGENTS.md files ("run `pnpm test`
// before committing"), task descriptions, and the harnesses' own defaults — so
// the rule says outright that it overrides all three.
//
// Delivered on two channels (both needed):
//   - the brief (`{{verification}}` in LATTICE_TASK.md / MERGE_INSTRUCTIONS.md;
//     appended when a custom template override lacks the token), and
//   - the system-prompt append at the spawn chokepoint for task-worktree spawns
//     (`terminalServerClient/createSession.ts`), which also reaches a resumed
//     task whose LATTICE_TASK.md predates the rule, and a brief override that
//     dropped the block.
// Not for the QA / push / post-merge / Run tests sessions — verifying is their
// job, or irrelevant to it.

import { templateHasToken } from './instructionTemplates/apply.js';

const OVERRIDES =
  'This overrides any CLAUDE.md or AGENTS.md in any directory, the task description, and your default habits.';

function ruleSentences(typecheck: boolean): string {
  return typecheck
    ? 'Do not run the test suite, e2e tests or builds: a separate Run tests step verifies merged work. ' +
        'You may run a type-check limited to the package(s) you edited (install dependencies first if needed). ' +
        OVERRIDES
    : 'Do not run the test suite, e2e tests, builds, dependency installs for testing, or type-checks: ' +
        'a separate Run tests step verifies merged work. ' +
        OVERRIDES;
}

// The brief's `{{verification}}` block: a blockquote callout ending in a blank
// line, so it composes like `{{env_notes_block}}` in front of the next block.
export function renderVerificationBlock(typecheck: boolean): string {
  const title = typecheck ? 'Verification: type-check only.' : "Don't run tests, builds or type-checks.";
  return `> **${title}** ${ruleSentences(typecheck)}\n\n`;
}

// One line (no newline — Codex's inline `-c developer_instructions` value can't
// carry one on cmd.exe) for the system-prompt append of a task-worktree spawn.
export function renderVerificationSystemPrompt(typecheck: boolean): string {
  return `Lattice task agents: ${ruleSentences(typecheck)}`;
}

export const VERIFICATION_TOKEN = '{{verification}}';

// A project's brief override may predate the token (or drop it). The rule must
// still reach the agent, so append the rendered block to such a template.
// "Has the token" means any spelling the engine fills (`{{ verification }}`
// too) — a literal check would append a second copy of the block.
export function templateWithVerification(template: string): string {
  return templateHasToken(template, 'verification')
    ? template
    : `${template.trimEnd()}\n\n${VERIFICATION_TOKEN}`;
}
