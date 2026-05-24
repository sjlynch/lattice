// Renders WORKFLOW_STEP.md — the agent's prompt for a single workflow step.
//
// Includes the helper-script usage docs and the harness-appropriate
// completion instructions: Claude relies on its Stop hook (silent stop), Pi
// relies on its session_shutdown extension *plus* an explicit curl as a
// backstop, codex always curls itself.

import { canonicalProjectPath } from '../projectPath.js';
import type { Workflow, WorkflowStepHarness } from '../workflows.js';
import type { WorkflowRun } from './state.js';

export function effectiveStepHarness(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
): WorkflowStepHarness {
  return run.harnessOverride ?? wf.steps[stepIndex].harness ?? 'claude';
}

export function renderStepMarkdown(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): string {
  const step = wf.steps[stepIndex];
  const harness = effectiveStepHarness(wf, run, stepIndex);
  const canonicalProject = canonicalProjectPath(wf.projectPath);
  const encodedProject = encodeURIComponent(canonicalProject);
  const completeUrl = `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`;
  // Pi/Codex completion instructions intentionally mirror LATTICE_TASK.md's
  // strong autonomy framing: the workflow is sequential and the run will not
  // advance to the next step until /complete fires. Pi gets a brief note that
  // a session_shutdown extension is installed as a backstop — useful so the
  // model knows abnormal exits won't strand the run, but it's not framed as a
  // permission to skip the explicit curl (the backstop is best-effort).
  const completionInstructions =
    harness === 'claude'
      ? [
          'After creating all the tasks described above, simply stop. Your session',
          'will be finalized automatically and the next workflow step (if any) will',
          'be queued.',
        ]
      : [
          '**Final step — tell Lattice this step is done (do not skip this).**',
          'The workflow will not advance to the next step until this URL is POSTed.',
          'Run this as your *last* action — do not end your turn before it succeeds:',
          '',
          '```bash',
          `curl -s -m 5 -X POST "${completeUrl}?source=model-explicit-curl"`,
          '```',
          ...(harness === 'pi'
            ? [
                '',
                'A `session_shutdown` extension (`.pi/extensions/lattice-complete.ts`)',
                'in this directory will fire the same callback as a backstop if your',
                "session exits without running the curl — but it's best-effort, so",
                'always run the curl yourself.',
              ]
            : []),
        ];
  const autonomyPreamble =
    harness === 'claude'
      ? ''
      : [
          '> **This is an autonomous workflow-step session — there is no user',
          '> watching to confirm with, and the run will not be picked up again',
          "> if you stop early.** Work through the whole step to completion in",
          '> this same session, without pausing to ask for permission or approval.',
          '> That includes the wrap-up: create the tasks described below and POST',
          "> the `/complete` callback at the very end. Stopping after \"I created",
          "> the tasks\" — without calling `/complete` — leaves the workflow run",
          "> stuck on this step and the next step never spawns. Don't end your",
          "> turn until you've run the curl below.",
          '',
        ].join('\n');
  return [
    `# Workflow Step ${stepIndex + 1} of ${wf.steps.length}: ${step.title}`,
    '',
    '## Your Task',
    '',
    autonomyPreamble,
    step.prompt,
    '',
    '## Active project (use ONLY this one)',
    '',
    `\`${canonicalProject}\``,
    '',
    'Every Lattice API call you make must be for this project. The helper',
    'script below has the project baked in — prefer it over raw curl so you',
    "can't accidentally hit a different project's board. If you do use curl,",
    'verify the response\'s `canonicalProject` field matches the path above',
    'before acting on the data.',
    '',
    '## Reading the board — query the API, not local files',
    '',
    'The live task DB is the API. **Do not read `tasks.json`, `tasks-current.json`,',
    '`combined-tasks.json`, `lattice_tasks.json`, or any similar file you find',
    'in this directory or sibling workflow-step directories** — those are stale',
    'scratch dumps left by previous agents and they will mislead you (the canonical',
    "example: they often miss whole lanes like 'qa' or 'ready_to_merge'). Always",
    "use `node create-task.cjs --list` or the API; that's the source of truth.",
    ...(run.harnessOverride
      ? [
          '',
          `Run harness override: every step in this run is using ${run.harnessOverride}.`,
        ]
      : []),
    '',
    'You can inspect the project files at that path if helpful.',
    'Your primary role here is to create tasks on the Lattice board so that',
    'code agents can do the implementation work. Do not write or commit code directly.',
    '',
    '## Creating tasks — use the helper script',
    '',
    'A `create-task.cjs` script is in this directory. It handles JSON serialization',
    "for you so you never need to escape quotes, backticks, or special characters,",
    "and every command targets only this project's board.",
    '',
    '**Single task (inline description):**',
    '```bash',
    'node create-task.cjs "Task title" "Short description here"',
    '```',
    '',
    '**Single task with a long/complex description (write to a file first):**',
    '```bash',
    "cat > desc.md << 'EOF'",
    'Your description here. Backticks `like this`, quotes "like this",',
    'and even (parentheses) are all fine inside a single-quoted heredoc.',
    'EOF',
    'node create-task.cjs "Task title" < desc.md',
    '```',
    '',
    '**Multiple tasks at once (recommended when creating 3+ tasks):**',
    '```bash',
    "cat > tasks.json << 'EOF'",
    '[',
    '  { "title": "First task",  "description": "What to do" },',
    '  { "title": "Second task", "description": "Details..." }',
    ']',
    'EOF',
    'node create-task.cjs --batch tasks.json',
    '```',
    '',
    '### Read the board (always project-safe)',
    '```bash',
    'node create-task.cjs --list                  # every task on this project',
    'node create-task.cjs --list open             # one lane',
    'node create-task.cjs --list open,in_progress # multiple lanes',
    'node create-task.cjs --summary               # counts by status',
    '```',
    '',
    'If you ever need a raw curl, the response is an envelope — assert',
    '`.canonicalProject` matches the project path above before iterating',
    '`.tasks`:',
    '',
    '```bash',
    `curl -s "${backendOrigin}/api/tasks?project=${encodedProject}"`,
    '# → { project, canonicalProject, hash, count, mismatched, tasks: [...] }',
    '```',
    '',
    '## When you are done',
    '',
    ...completionInstructions,
  ].join('\n');
}
