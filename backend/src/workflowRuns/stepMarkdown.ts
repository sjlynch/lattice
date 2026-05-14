// Renders WORKFLOW_STEP.md — the agent's prompt for a single workflow step.
//
// Includes the helper-script usage docs and the harness-appropriate
// completion instructions: Claude relies on its Stop hook (silent stop), Pi
// relies on its session_shutdown extension *plus* an explicit curl as a
// backstop, codex always curls itself.

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
  const encodedProject = encodeURIComponent(wf.projectPath);
  const completeUrl = `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`;
  const completionInstructions =
    harness === 'claude'
      ? [
          'After creating all the tasks described above, simply stop. Your session',
          'will be finalized automatically and the next workflow step (if any) will',
          'be queued.',
        ]
      : [
          'After creating all the tasks described above, POST the completion callback',
          'yourself as the final action so Lattice can queue the next workflow step:',
          '```bash',
          `curl -s -m 5 -X POST ${completeUrl}`,
          '```',
        ];
  return [
    `# Workflow Step ${stepIndex + 1} of ${wf.steps.length}: ${step.title}`,
    '',
    '## Your Task',
    '',
    step.prompt,
    '',
    '## About this project',
    '',
    `Project root: \`${wf.projectPath}\``,
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
    'for you so you never need to escape quotes, backticks, or special characters.',
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
    '### List existing tasks',
    '```bash',
    `curl -s "${backendOrigin}/api/tasks?project=${encodedProject}"`,
    '```',
    '',
    '## When you are done',
    '',
    ...completionInstructions,
  ].join('\n');
}
