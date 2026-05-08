// Workflow step runner.
//
// Each step spawns a Claude Code terminal session in a lightweight step
// directory under .lattice/workflow-steps/<runId>/step-<N>/. The directory
// contains WORKFLOW_STEP.md (step prompt + task board API docs) and a Stop
// hook that POSTs back when Claude exits. Sequential advancement is driven
// entirely by those callbacks — not by watching task state.
//
// 'parallel' steps are accepted in the schema but executed sequentially —
// the fan-out executor is intentionally deferred.

import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkflow, type Workflow } from './workflows.js';
import { proxyCreateSession } from './terminalProxy.js';

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
  const out: WorkflowRun[] = [];
  for (const r of runs.values()) {
    if (r.projectPath === projectPath && r.status === 'running') {
      out.push(snapshot(r));
    }
  }
  return out;
}

// Returns a standalone CommonJS Node script written to the step dir.
// Using .cjs avoids ESM/CJS ambiguity regardless of the project's
// package.json "type" setting — Node always interprets .cjs as CommonJS.
function renderHelperScript(projectPath: string, backendOrigin: string): string {
  // Escape for embedding in a JS string literal
  const safeProject = projectPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const safeBase = backendOrigin.replace(/'/g, "\\'");
  return `#!/usr/bin/env node
'use strict';
/**
 * create-task.cjs — Lattice task creation helper.
 *
 * Handles JSON serialization so you never have to worry about shell
 * quoting, backticks, or special characters in descriptions.
 *
 * Single task (description from second arg):
 *   node create-task.cjs "Task title" "Short description"
 *
 * Single task (description from stdin — pipe or redirect file):
 *   node create-task.cjs "Task title" < description.md
 *   echo "My description" | node create-task.cjs "Task title"
 *
 * Multiple tasks at once (recommended for 3+ tasks):
 *   node create-task.cjs --batch tasks.json
 *
 * tasks.json format:
 *   [
 *     { "title": "First task",  "description": "What to do" },
 *     { "title": "Second task", "description": "..." }
 *   ]
 */

const http = require('http');
const fs   = require('fs');

const PROJECT  = '${safeProject}';
const API_BASE = '${safeBase}';

function post(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port) || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

async function createOne(title, description) {
  const result = await post(API_BASE + '/api/tasks', { project: PROJECT, title, description });
  if (result.status >= 200 && result.status < 300) {
    const t = result.body;
    console.log('Created: "' + t.title + '" (id: ' + t.id + ')');
    return t;
  }
  const msg = (result.body && result.body.error) ? result.body.error : JSON.stringify(result.body);
  throw new Error('API ' + result.status + ': ' + msg);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--batch') {
    const file = args[1];
    if (!file) { console.error('Usage: node create-task.cjs --batch tasks.json'); process.exit(1); }
    let tasks;
    try { tasks = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error('Could not read ' + file + ': ' + e.message); process.exit(1); }
    if (!Array.isArray(tasks)) { console.error('tasks.json must be a JSON array'); process.exit(1); }
    const result = await post(API_BASE + '/api/tasks/batch', { project: PROJECT, tasks });
    if (result.status >= 200 && result.status < 300) {
      const created = result.body;
      console.log('Created ' + created.length + ' task(s):');
      for (const t of created) console.log('  ' + t.title + ' (' + t.id + ')');
    } else {
      const msg = (result.body && result.body.error) ? result.body.error : JSON.stringify(result.body);
      console.error('API error: ' + msg);
      process.exit(1);
    }
    return;
  }

  const title = args[0];
  if (!title) {
    console.error('Usage: node create-task.cjs "Title" ["Description"]');
    console.error('       node create-task.cjs "Title" < description.md');
    console.error('       node create-task.cjs --batch tasks.json');
    process.exit(1);
  }
  const description = args[1] !== undefined ? args[1] : await readStdin();
  await createOne(title, description);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
`;
}

function renderStepMarkdown(
  wf: Workflow,
  stepIndex: number,
  backendOrigin: string,
): string {
  const step = wf.steps[stepIndex];
  const encodedProject = encodeURIComponent(wf.projectPath);
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
    'After creating all the tasks described above, simply stop. Your session',
    'will be finalized automatically and the next workflow step (if any) will',
    'be queued.',
  ].join('\n');
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
  await fs.writeFile(stepFile, renderStepMarkdown(wf, stepIndex, backendOrigin), 'utf8');

  // Helper script so Claude can create tasks without shell quoting issues.
  await fs.writeFile(
    path.join(stepDir, 'create-task.cjs'),
    renderHelperScript(wf.projectPath, backendOrigin),
    'utf8',
  );

  const claudeDir = path.join(stepDir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const hookConfig = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `curl -s -m 5 -X POST ${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`,
            },
          ],
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(claudeDir, 'settings.local.json'),
    JSON.stringify(hookConfig, null, 2),
    'utf8',
  );

  const command = `claude --dangerously-skip-permissions "Please read WORKFLOW_STEP.md and complete the workflow step described in it."`;

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
