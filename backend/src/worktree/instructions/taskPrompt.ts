import type { Task } from '../../tasks.js';
import type { AgentHarness } from '../../harnesses.js';
import type { DeadCodeSummary } from '../../deadCode.js';
import { canonicalProjectPath } from '../../projectPath.js';
import { renderEnvNotesBlock } from '../envDetect.js';

// Reference-only nudge: surfaced only when the analyzer confidently flags at
// least one unreachable file (`deadCode.total > 0`). Deliberately framed as
// optional context — an unrelated task (add a button, fix a bug) shouldn't be
// derailed into a dead-code hunt, and the scanner can't see dynamic/string-path
// loads, so the agent is told to verify before removing anything.
function renderDeadCodeBlock(
  deadCode: DeadCodeSummary | null,
  backendOrigin: string,
): string {
  if (!deadCode || deadCode.total === 0) return '';
  const sample = deadCode.files.slice(0, 5).map((f) => `\`${f.path}\``);
  const more = deadCode.total - sample.length;
  const sampleLine =
    sample.length > 0
      ? `> e.g. ${sample.join(', ')}${more > 0 ? `, …and ${more} more` : ''}.\n>\n`
      : '';
  return `> **Dead-code scan (optional context).** Lattice's analyzer currently flags
> **${deadCode.total} file(s)** in this project as possibly unreachable — not
> imported from any detected entry point.
${sampleLine}> This is a heuristic: it can't see dynamic \`import()\`, string-path/\`fs\`
> loads, or framework magic, so a flagged file may well be live. **Only act on
> this if your task involves cleanup, refactoring, or deleting code** — don't
> go out of your way otherwise. If it is relevant, fetch the current list and
> **verify each file is genuinely dead** (grep for its name, check for dynamic
> loads) before removing it:
>
> \`\`\`
> curl -sG "${backendOrigin}/api/health/dead-code" --data-urlencode "project=$LATTICE_PROJECT"
> \`\`\`

`;
}

// `harness` controls a couple of pieces. Claude (the default) ends the
// session and its Stop hook in `.claude/settings.local.json` POSTs
// `/complete`. Pi and Codex have no command-hook mechanism, so the model
// itself must run the whole tail end of the checklist — commit, PATCH the
// description, POST `/complete` — without stopping to ask. (For Pi a
// worktree-local extension, installPiCompletionExtension, also POSTs
// `/complete` on session exit as a backstop, but the model should not rely
// on it.) The non-Claude variant therefore gets an explicit "this is an
// autonomous session, finish everything" preamble and a stronger final step.
export function renderTaskMarkdown(
  task: Task,
  backendOrigin: string,
  harness: AgentHarness = 'claude',
  envNotes: string[] = [],
  deadCode: DeadCodeSummary | null = null,
): string {
  const created = new Date(task.createdAt).toISOString();
  const desc = task.description?.trim() || '_(no description provided)_';
  const envBlock = renderEnvNotesBlock(envNotes);
  const deadCodeBlock = renderDeadCodeBlock(deadCode, backendOrigin);
  const autonomyPreamble =
    harness === 'claude'
      ? ''
      : `> **This is an autonomous worktree session — there is no user watching to
> confirm with, and the turn will not be picked up again.** Work through
> the whole checklist below to the end in this same session, without pausing
> to ask for permission or approval. That includes the wrap-up: commit your
> work, append a summary to the task description, and POST the \`/complete\` callback —
> these are part of the task, not optional follow-ups. Stopping after "I
> implemented it" — without committing and calling \`/complete\` — leaves
> the task stuck in "In Progress" and the work invisible to Lattice. Don't
> end your turn until you've run the \`/complete\` curl (or deliberately
> determined there's nothing to commit, in which case say so).

`;
  const finalStep =
    harness === 'claude'
      ? `5. End the session normally. Lattice's Stop hook will verify the commit and move this task to "Ready to Merge" automatically.`
      : `5. **Final step — tell Lattice you're done (do not skip this).** Lattice
   can't auto-detect this session ending, so the *last thing you do* must
   be:

   \`\`\`
   curl -s -m 5 -X POST "${backendOrigin}/api/tasks/${task.id}/complete?source=model-explicit-curl"
   \`\`\`

   This is what moves the task to "Ready to Merge". Run it yourself — don't
   ask the user to, and don't end your turn before running it. The only time
   you skip it is if there is genuinely nothing committed on this branch (in
   which case Lattice leaves the task In Progress so it can be resumed);
   even then, say so explicitly rather than just stopping.`;
  const projectPath = canonicalProjectPath(task.projectPath);
  return `# ${task.title}

${desc}

---

**Lattice task ID:** \`${task.id}\`
**Project:** \`${projectPath}\`
**Created:** ${created}

> You are working on this single task. You should not need to query the
> Lattice task board to complete it — but if you do, pass exactly the
> project path above as \`project=\`, and see \`$LATTICE_DOCS\`
> (\`.lattice/LATTICE_API.md\`) for the API.

## Instructions (please complete autonomously, no need to confirm with the user)

${autonomyPreamble}${envBlock}${deadCodeBlock}1. **Check existing state first.** This task may have been started in a
   prior session — Lattice can resume worktrees after a server restart or
   when Claude finishes without committing. Before doing anything, run:

   \`\`\`
   git log --oneline -10
   git status
   \`\`\`

   - If there are commits on this branch, read them with \`git show <sha>\`
     to understand what's already been implemented.
   - If there are uncommitted changes, review them with \`git diff\` and
     decide whether to keep, amend, or rework them.
   - Only redo work that's clearly broken or out of scope. Don't restart
     the implementation from scratch when it's already partially done.

2. Implement the task described above (continuing from the prior state if
   any).

3. **Commit your work** before ending the session — Lattice merges your
   branch via \`git merge\`, so a commit is required for changes to land:

   \`\`\`
   git add -A
   git commit -m "<concise summary of the change>"
   \`\`\`

4. **Append a short summary of your changes to the task** so the task
   board reflects what was actually done once it lands in "Ready to
   Merge":

   \`\`\`
   curl -s -X POST ${backendOrigin}/api/tasks/${task.id}/append-summary \\
     -H "Content-Type: application/json" \\
     -d '{"summary":"<1-3 bullet summary of what changed>"}'
   \`\`\`

   Keep it concise (1-3 bullet points). This appends the summary beneath
   the original description — both remain visible on the task board.

${finalStep}

Please do not start, stop, or restart any dev servers — the user runs
them in their own console and your output goes to the worktree's terminal.
`;
}
