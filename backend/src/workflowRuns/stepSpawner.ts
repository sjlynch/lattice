// Materializes one workflow step on disk and pre-spawns its terminal.
//
// Per-step setup: create .lattice/workflow-steps/<runId>/step-<N>/, write
// WORKFLOW_STEP.md + create-task.cjs, install the Stop hook (Claude) and
// session_shutdown extension (Pi), build the harness command, ask the
// terminal-server to allocate a pty, then fan out 'step-spawned' +
// 'progress' WS events. The pty is pre-spawned so the frontend can
// lazy-mount its terminal pane without burning a WebGL context for a step
// the user may never click into.

import path from 'node:path';
import fs from 'node:fs/promises';
import { proxyCreateSession } from '../terminalProxy.js';
import { installClaudeStopHook } from '../claudeStopHook.js';
import { buildClaudeCommand, buildCodexCommand, buildPiCommand } from '../worktree/commands.js';
import type { Workflow } from '../workflows.js';
import { renderHelperScript } from './renderHelperScript.js';
import { effectiveStepHarness, renderStepMarkdown } from './stepMarkdown.js';
import { notify, snapshot, type WorkflowRun } from './state.js';

function buildWorkflowStepCommand(
  stepFile: string,
  harness: Workflow['steps'][number]['harness'],
): string {
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

export async function spawnWorkflowStep(
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
  const harness = effectiveStepHarness(wf, run, stepIndex);
  await fs.writeFile(stepFile, renderStepMarkdown(wf, run, stepIndex, backendOrigin), 'utf8');

  // Helper script so the agent can create tasks without shell quoting issues.
  await fs.writeFile(
    path.join(stepDir, 'create-task.cjs'),
    renderHelperScript(wf.projectPath, backendOrigin),
    'utf8',
  );

  const completionUrl = `${backendOrigin}/api/workflow-runs/${run.id}/steps/${stepIndex}/complete`;
  await installClaudeStopHook(stepDir, completionUrl);
  if (harness === 'pi') {
    await installPiWorkflowCompletionExtension(stepDir, completionUrl);
  }

  const command = buildWorkflowStepCommand(stepFile, harness);

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
