// Scratch-directory lifecycle for workflow runs.
//
// Each run materializes `<project>/.lattice/workflow-steps/<runId>/`. This
// module owns marking that dir as scratch (writeScratchReadme) and pruning
// older runs so they stop accumulating misleading `tasks*.json` snapshots
// that later agents grep and trust (pruneOldWorkflowRuns).

import path from 'node:path';
import fs from 'node:fs/promises';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { isPathStrictlyInside } from '../worktree/paths.js';
import { pruneReparsePointsUnder } from '../worktree/reparsePoints.js';

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
Lattice HTTP API — see \`.lattice/LATTICE_API.md\` at the project
root, which carries this project's literal API URL and project path.

A previous agent missed an entire 'qa' lane because it grep'd \`.lattice/\`
and trusted a sibling-step \`tasks.json\` snapshot over the API. Don't be
that agent — query the API.

This dir is automatically pruned after ${WORKFLOW_RUN_RETENTION} runs.
`;

// Canonical scratch paths for a run/step. Single source of truth: the step
// spawner materializes these, and boot recovery derives the same path to find
// the step's still-live pty by cwd (see recovery/workflowRunResume.ts).
export function workflowStepsRootDir(projectPath: string): string {
  return path.join(projectPath, '.lattice', 'workflow-steps');
}

export function workflowRunDir(projectPath: string, runId: string): string {
  return path.join(workflowStepsRootDir(projectPath), runId);
}

export function workflowStepDir(
  projectPath: string,
  runId: string,
  stepIndex: number,
): string {
  return path.join(workflowRunDir(projectPath, runId), `step-${stepIndex}`);
}

// Tag the run dir as scratch. Returns true if this call freshly materialized
// the run dir's README (i.e. it is the FIRST step to spawn for this run),
// false if the README already existed (a later step). Callers use the `true`
// signal to run once-per-run setup like pruning, instead of keying off
// `stepIndex === 0` — which misses any run whose step 0 is a headless control
// step (start/merge/push), since those never spawn into the scratch dir.
export async function writeScratchReadme(runDir: string): Promise<boolean> {
  const readmePath = path.join(runDir, 'README.md');
  try {
    // Exclusive create: parallel members must not both prune the same old runs.
    await fs.writeFile(readmePath, SCRATCH_README, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    console.warn(`[workflow-step] failed to write scratch README at ${readmePath}:`, err);
    return false;
  }
  return true;
}

// Prune older wfrun_* directories so they stop accumulating misleading
// `tasks*.json` snapshots that later agents grep and trust.
//
// `keepRunId` is the run currently spawning; `activeRunIds` is the set of ALL
// runs still `running` for the project (from state.ts `runs`). Both are
// excluded from deletion. Guarding the whole active set — not just the current
// run — is load-bearing: concurrent workflow runs are allowed, and a run parked
// on a long agent step keeps a stale run-dir mtime (only advancing a step bumps
// it). Without this, a burst of newer runs could push a still-active run past
// the retention window and prune its step-N/WORKFLOW_STEP.md, create-task.cjs,
// and .claude Stop-hook config out from under it, leaving it hung (no /complete
// fires). This mirrors the homeScratch boot sweep's `hasLiveSessionAtOrUnder`
// guard.
//
// Recursive delete inside the project tree needs the same defence-in-depth
// the push-run cleanup uses: bound the target to `<workflowStepsRoot>/wfrun_*`
// strictly, refuse if the path is a symlink/junction whose realpath escapes,
// and strip any reparse points inside before recursing so we cannot walk a
// junction loop into `.git` or anywhere else.
export async function pruneOldWorkflowRuns(
  workflowStepsRoot: string,
  keepRunId: string,
  activeRunIds: ReadonlySet<string> = new Set(),
): Promise<void> {
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
  // Keep the newest WORKFLOW_RUN_RETENTION by mtime, and NEVER delete a run
  // that is still spawning (keepRunId) or otherwise `running` (activeRunIds),
  // regardless of mtime — a live run's scratch is not disposable.
  const sorted = entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const toDelete = sorted
    .slice(WORKFLOW_RUN_RETENTION)
    .filter((e) => e.name !== keepRunId && !activeRunIds.has(e.name));
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
