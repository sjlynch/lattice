// Workflow step runner.
//
// Each step spawns a selected agent terminal session in a lightweight step
// directory under .lattice/workflow-steps/<runId>/step-<N>/. The directory
// contains WORKFLOW_STEP.md (step prompt + task board API docs) and completion
// hooks/instructions that POST back when the agent exits or finishes.
// Sequential advancement is driven entirely by those callbacks — not by
// watching task state.
//
// 'parallel' steps are accepted in the schema but executed sequentially —
// the fan-out executor is intentionally deferred.

import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkflow, type Workflow } from './workflows.js';
import { proxyCreateSession } from './terminalProxy.js';
import { canonicalProjectPath } from './projectPath.js';
import { installClaudeStopHook } from './claudeStopHook.js';
import { buildClaudeCommand, buildCodexCommand, buildPiCommand } from './worktree/commands.js';
import { renderHelperScript } from './workflowRuns/renderHelperScript.js';

export type WorkflowRunStatus = 'running' | 'completed' | 'errored' | 'cancelled';

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  projectPath: string;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt?: number;
  totalSteps: number;
  currentStepIndex: number;
  error?: string;
};

export type WorkflowRunEvent =
  | { type: 'started'; run: WorkflowRun }
  | { type: 'progress'; run: WorkflowRun }
  | { type: 'completed'; run: WorkflowRun }
  | { type: 'errored'; run: WorkflowRun }
  | { type: 'cancelled'; run: WorkflowRun }
  | {
      type: 'step-spawned';
      runId: string;
      projectPath: string;
      stepIndex: number;
      command: string;
      cwd: string;
      serverId?: string;
    };

const runs = new Map<string, WorkflowRun>();
const listeners = new Set<(ev: WorkflowRunEvent) => void>();

function snapshot(run: WorkflowRun): WorkflowRun {
  return { ...run };
}

function notify(ev: WorkflowRunEvent): void {
  for (const fn of listeners) fn(ev);
}

export function subscribe(fn: (ev: WorkflowRunEvent) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getRun(id: string): WorkflowRun | null {
  const r = runs.get(id);
  return r ? snapshot(r) : null;
}

export function getActiveRunsForProject(projectPath: string): WorkflowRun[] {
  const key = canonicalProjectPath(projectPath);
  const out: WorkflowRun[] = [];
  for (const r of runs.values()) {
    if (r.projectPath === key && r.status === 'running') {
      out.push(snapshot(r));
    }
  }
  return out;
}

function renderStepMarkdown(
  wf: Workflow,
  runId: string,
  stepIndex: number,
  backendOrigin: string,
): string {
  const step = wf.steps[stepIndex];
  const encodedProject = encodeURIComponent(wf.projectPath);
  const completeUrl = `${backendOrigin}/api/workflow-runs/${runId}/steps/${stepIndex}/complete`;
  const completionInstructions =
    step.harness === 'claude'
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

function buildWorkflowStepCommand(stepFile: string, harness: Workflow['steps'][number]['harness']): string {
  if (harness === 'pi') return buildPiCommand(stepFile);
  if (harness === 'codex') return buildCodexCommand(stepFile);
  return buildClaudeCommand(stepFile);
}

async function installPiWorkflowCompletionExtension(
  stepDir: string,
  callbackUrl: string,
): Promise<void> {
  const extDir = path.join(stepDir, '.pi', 'extensions');
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(
    path.join(extDir, 'lattice-workflow-complete.ts'),
    `// Lattice-managed — reports workflow-step completion when the Pi session exits.
export default function (pi) {
  pi.on("session_shutdown", async (event) => {
    if (event && event.reason && event.reason !== "quit") return;
    try {
      await fetch(${JSON.stringify(callbackUrl)}, { method: "POST" });
    } catch {
      // best-effort, same as the curl-based Stop hook
    }
  });
}
`,
    'utf8',
  );
}

async function spawnWorkflowStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<{ command: string; cwd: string }> {
  const stepDir = path.join(
    wf.projectPath,
    '.lattice',
    'workflow-steps',
    run.id,
    `step-${stepIndex}`,
  );
  await fs.mkdir(stepDir, { recursive: true });

  const stepFile = path.join(stepDir, 'WORKFLOW_STEP.md');
  await fs.writeFile(stepFile, renderStepMarkdown(wf, run.id, stepIndex, backendOrigin), 'utf8');

  // Helper script so the agent can create tasks without shell quoting issues.
  await fs.writeFile(
    path.join(stepDir, 'create-task.cjs'),
    renderHelperScript(wf.projectPath, backendOrigin),
    'utf8',
  );

  const completionUrl = `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`;
  await installClaudeStopHook(stepDir, completionUrl);
  if (wf.steps[stepIndex].harness === 'pi') {
    await installPiWorkflowCompletionExtension(stepDir, completionUrl);
  }

  const command = buildWorkflowStepCommand(stepFile, wf.steps[stepIndex].harness);

  // Pre-spawn the pty so the frontend can lazy-mount its terminal pane and
  // not burn a WebGL context for a step the user may not click into.
  const sess = await proxyCreateSession({
    cwd: stepDir,
    initialCommand: command,
    projectPath: wf.projectPath,
  });
  if ('error' in sess) {
    console.warn(
      `[workflow-run] ${run.id} step ${stepIndex}: pre-spawn failed: ${sess.error}`,
    );
  }

  notify({
    type: 'step-spawned',
    runId: run.id,
    projectPath: wf.projectPath,
    stepIndex,
    command,
    cwd: stepDir,
    serverId: 'id' in sess ? sess.id : undefined,
  });
  notify({ type: 'progress', run: snapshot(run) });

  return { command, cwd: stepDir };
}

export async function startWorkflowRun(
  workflowId: string,
  backendOrigin: string,
): Promise<WorkflowRun> {
  const wf = await getWorkflow(workflowId);
  if (!wf) throw new Error('workflow not found');
  if (wf.steps.length === 0) throw new Error('workflow has no steps');

  const run: WorkflowRun = {
    id: `wfrun_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    workflowId: wf.id,
    workflowName: wf.name,
    projectPath: wf.projectPath,
    status: 'running',
    startedAt: Date.now(),
    totalSteps: wf.steps.length,
    currentStepIndex: 0,
  };
  runs.set(run.id, run);
  notify({ type: 'started', run: snapshot(run) });
  console.log(
    `[workflow-run] ${run.id} started (workflow=${wf.id} "${wf.name}", ${wf.steps.length} step(s))`,
  );

  try {
    await spawnWorkflowStep(wf, run, 0, backendOrigin);
    return snapshot(run);
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'spawn failed';
    notify({ type: 'errored', run: snapshot(run) });
    console.error(`[workflow-run] ${run.id} failed to start step 0:`, err);
    throw err;
  }
}

export function cancelWorkflowRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'cancelled';
  run.finishedAt = Date.now();
  notify({ type: 'cancelled', run: snapshot(run) });
  console.log(`[workflow-run] ${run.id} cancelled`);
  return true;
}

// Called by the Stop-hook callback. Idempotent: stale hooks (same stepIndex
// re-firing) are silently ignored via the currentStepIndex check.
export async function completeWorkflowStep(
  runId: string,
  stepIndex: number,
  backendOrigin: string,
): Promise<void> {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return;
  if (stepIndex !== run.currentStepIndex) return;

  const nextIndex = stepIndex + 1;
  // Claim ownership synchronously before any await so a duplicate Stop-hook
  // fire is ignored by the check above.
  run.currentStepIndex = nextIndex;

  try {
    const wf = await getWorkflow(run.workflowId);
    if (!wf) {
      run.status = 'errored';
      run.finishedAt = Date.now();
      run.error = 'workflow definition not found';
      notify({ type: 'errored', run: snapshot(run) });
      return;
    }
    if (nextIndex >= wf.steps.length) {
      run.status = 'completed';
      run.finishedAt = Date.now();
      console.log(`[workflow-run] ${run.id} completed all ${wf.steps.length} step(s)`);
      notify({ type: 'completed', run: snapshot(run) });
      return;
    }
    console.log(`[workflow-run] ${run.id} advancing step ${stepIndex} → ${nextIndex}`);
    await spawnWorkflowStep(wf, run, nextIndex, backendOrigin);
  } catch (err) {
    run.status = 'errored';
    run.finishedAt = Date.now();
    run.error = (err as Error).message ?? 'advance failed';
    console.error(`[workflow-run] ${run.id} advance failed:`, err);
    notify({ type: 'errored', run: snapshot(run) });
  }
}
