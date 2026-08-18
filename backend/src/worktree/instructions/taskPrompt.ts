import type { Task } from '../../tasks.js';
import type { AgentHarness } from '../../harnesses.js';
import type { DeadCodeSummary } from '../../deadCode.js';
import { canonicalProjectPath } from '../../projectPath.js';
import { renderEnvNotesBlock } from '../envDetect.js';
import { applyTemplate } from '../../instructionTemplates/apply.js';
import { DEFAULT_TASK_TEMPLATE } from '../../instructionTemplates/defs.js';

// Reference-only nudge: surfaced only when the analyzer confidently flags at
// least one unreachable file (`deadCode.total > 0`). Deliberately framed as
// optional context — an unrelated task (add a button, fix a bug) shouldn't be
// derailed into a dead-code hunt, and the scanner can't see dynamic/string-path
// loads, so the agent is told to verify before removing anything.
function renderDeadCodeBlock(
  deadCode: DeadCodeSummary | null,
  backendOrigin: string,
  projectPath: string,
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
> curl -sG "${backendOrigin}/api/health/dead-code" --data-urlencode "project=${projectPath}"
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
//
// `template` is the resolved per-project template (override or default); the
// caller looks it up via resolveInstructionTemplate so this stays synchronous.
export function renderTaskMarkdown(
  task: Task,
  backendOrigin: string,
  harness: AgentHarness = 'claude',
  envNotes: string[] = [],
  deadCode: DeadCodeSummary | null = null,
  template: string = DEFAULT_TASK_TEMPLATE,
): string {
  const created = new Date(task.createdAt).toISOString();
  const desc = task.description?.trim() || '_(no description provided)_';
  const envBlock = renderEnvNotesBlock(envNotes);
  const projectPath = canonicalProjectPath(task.projectPath);
  // The dead-code recipe gets the literal path in forward-slash form: it goes
  // straight into a shell command (no env var to expand any more), and Lattice
  // canonicalizes either separator to the same project.
  const deadCodeBlock = renderDeadCodeBlock(
    deadCode,
    backendOrigin,
    projectPath.replace(/\\/g, '/'),
  );
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
  return applyTemplate(template, {
    task_title: task.title,
    task_description: desc,
    task_id: task.id,
    project_path: projectPath,
    created_at: created,
    backend_origin: backendOrigin,
    autonomy_preamble: autonomyPreamble,
    env_notes_block: envBlock,
    dead_code_block: deadCodeBlock,
    final_step: finalStep,
  });
}
