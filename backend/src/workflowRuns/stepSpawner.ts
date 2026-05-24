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
import { enqueueSpawn, SpawnCapacityError } from '../spawnQueue.js';
import { installClaudeStopHook } from '../claudeStopHook.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { buildClaudeCommand, buildCodexCommand, buildPiCommand } from '../worktree/commands.js';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { isPathStrictlyInside } from '../worktree/paths.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';
import type { Workflow } from '../workflows.js';
import { renderHelperScript } from './renderHelperScript.js';
import { effectiveStepHarness, renderStepMarkdown } from './stepMarkdown.js';
import { notify, snapshot, type WorkflowRun } from './state.js';

// Keep this many most-recent workflow-run dirs; older ones get pruned when
// a new run starts. The scratch is per-step Claude/Pi context — useful for
// debugging the very recent past, but old runs accumulate `tasks*.json`
// dumps that later agents mistake for the source of truth.
const WORKFLOW_RUN_RETENTION = 5;

const SCRATCH_README = `# Workflow-run scratch — NOT the source of truth

This directory holds per-step working files for a Lattice workflow run:

  step-<N>/WORKFLOW_STEP.md   — the agent's prompt
  step-<N>/create-task.cjs    — helper script to call the Lattice API
  step-<N>/.claude/           — Claude Stop hook config
  step-<N>/.pi/               — Pi session_shutdown extension

**Any \`tasks.json\`, \`tasks-current.json\`, \`combined-tasks.json\`, or
similar file written here by an agent is a stale scratch snapshot. Do not
treat it as the live task DB.** The live task board lives behind the
Lattice HTTP API at \`$LATTICE_API_URL/api/tasks\` (see
\`.lattice/LATTICE_API.md\` at the project root).

A previous agent missed an entire 'qa' lane because it grep'd \`.lattice/\`
and trusted a sibling-step \`tasks.json\` snapshot over the API. Don't be
that agent — query the API.

This dir is automatically pruned after ${WORKFLOW_RUN_RETENTION} runs.
`;

export async function writeScratchReadme(runDir: string): Promise<void> {
  const readmePath = path.join(runDir, 'README.md');
  try {
    await fs.access(readmePath);
    return;
  } catch {
    // fall through to write
  }
  try {
    await fs.writeFile(readmePath, SCRATCH_README, 'utf8');
  } catch (err) {
    console.warn(`[workflow-step] failed to write scratch README at ${readmePath}:`, err);
  }
}

// Prune older wfrun_* directories so they stop accumulating misleading
// `tasks*.json` snapshots that later agents grep and trust.
//
// Recursive delete inside the project tree needs the same defence-in-depth
// the push-run cleanup uses: bound the target to `<workflowStepsRoot>/wfrun_*`
// strictly, refuse if the path is a symlink/junction whose realpath escapes,
// and strip any reparse points inside before recursing so we cannot walk a
// junction loop into `.git` or anywhere else.
export async function pruneOldWorkflowRuns(workflowStepsRoot: string, keepRunId: string): Promise<void> {
  let entries: { name: string; mtimeMs: number }[];
  try {
    const names = await fs.readdir(workflowStepsRoot);
    entries = [];
    for (const name of names) {
      // Only touch wfrun_* directories — leave anything else alone.
      if (!name.startsWith('wfrun_')) continue;
      try {
        const stat = await fs.stat(path.join(workflowStepsRoot, name));
        if (stat.isDirectory()) entries.push({ name, mtimeMs: stat.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  } catch {
    // workflowStepsRoot doesn't exist yet → nothing to prune
    return;
  }
  if (entries.length <= WORKFLOW_RUN_RETENTION) return;
  // Always keep the run we are currently spawning into, even if mtime-sorted.
  const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = sorted
    .slice(WORKFLOW_RUN_RETENTION)
    .filter((e) => e.name !== keepRunId);
  for (const entry of toDelete) {
    const target = path.join(workflowStepsRoot, entry.name);
    try {
      // Hard bound: the path must be a strict descendant of workflowStepsRoot
      // and must start with wfrun_. A bug-introduced empty entry.name, or any
      // other path-construction slip, fails here before fs.rm touches disk.
      if (!isPathStrictlyInside(workflowStepsRoot, target)) {
        console.warn(
          `[workflow-step] prune: refusing ${target} — not strictly inside ${workflowStepsRoot}`,
        );
        continue;
      }
      await assertNotReparsePoint(target);
      // Strip any junctions/symlinks inside the run dir first so fs.rm cannot
      // walk a reparse-point loop out of the bounded target.
      await pruneReparsePointsUnder(target);
      await fs.rm(target, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[workflow-step] prune failed for ${target}:`, err);
    }
  }
}

function buildWorkflowStepCommand(
  stepFile: string,
  harness: Workflow['steps'][number]['harness'],
): string {
  if (harness === 'pi') return buildPiCommand(stepFile);
  if (harness === 'codex') return buildCodexCommand(stepFile);
  return buildClaudeCommand(stepFile);
}

export async function spawnWorkflowStep(
  wf: Workflow,
  run: WorkflowRun,
  stepIndex: number,
  backendOrigin: string,
): Promise<{ command: string; cwd: string }> {
  const workflowStepsRoot = path.join(wf.projectPath, '.lattice', 'workflow-steps');
  const runDir = path.join(workflowStepsRoot, run.id);
  const stepDir = path.join(runDir, `step-${stepIndex}`);
  await fs.mkdir(stepDir, { recursive: true });
  // Mark the run dir as scratch (and prune older runs) on the first step.
  // Done after mkdir so the run dir definitely exists; idempotent on later
  // steps because writeScratchReadme no-ops if the README is already there.
  await writeScratchReadme(runDir);
  if (stepIndex === 0) {
    await pruneOldWorkflowRuns(workflowStepsRoot, run.id);
  }

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
  // Always install BOTH backstops regardless of harness (defence-in-depth):
  // a harness switch mid-run would otherwise lose the callback, and the
  // unused one is inert. The Pi gate is disabled here because the workflow-
  // step `/complete` route has no destructive side effect — abnormal exits
  // should still advance the run rather than wedge it.
  //
  // The Claude Stop hook URL carries `?source=` so the /complete log line
  // can identify the firing mechanism; the Pi extension does the same via
  // piExtension.ts.
  await installClaudeStopHook(
    stepDir,
    `${completionUrl}?source=claude-stop-hook-workflow-step-complete`,
  );
  await installPiCompletionExtension({
    dir: stepDir,
    callbackUrl: completionUrl,
    site: 'workflow-step-complete',
    respectQuitGate: false,
  });
  console.log(
    `[workflow-step] installed Claude+Pi backstops for run ${run.id} step ${stepIndex} ` +
      `(active harness=${harness}, dir=${stepDir})`,
  );

  const command = buildWorkflowStepCommand(stepFile, harness);

  // Route the pty allocation through the spawn queue (fire-and-forget, like
  // task runs): the step dir is materialized above, only the pty waits for
  // concurrency headroom. `step-spawned` fires from inside the thunk so it
  // naturally lands when the queue admits the step, and the frontend
  // (useWorkflowRuns) lazy-mounts the terminal off that event — exactly the
  // pre-queue flow, just deferred.
  const { done } = enqueueSpawn<void>({
    kind: 'workflow-step',
    priority: 'batch',
    dedupeKey: `wf-step:${run.id}:${stepIndex}`,
    thunk: async () => {
      const sess = await proxyCreateSession({
        cwd: stepDir,
        initialCommand: command,
        projectPath: wf.projectPath,
      });
      if ('error' in sess) {
        if (sess.code === 'CAP') {
          throw new SpawnCapacityError(
            `workflow step ${run.id}/${stepIndex}: terminal-server hard cap`,
          );
        }
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
    },
  });
  // Fire-and-forget: the thunk handles its own errors (CAP is retried inside
  // the queue). Swallow the rejection so it is not an unhandled rejection.
  done.catch(() => {});

  // Emit progress now — the step is the run's current step whether its pty
  // is spawning immediately or waiting in the queue.
  notify({ type: 'progress', run: snapshot(run) });

  return { command, cwd: stepDir };
}
