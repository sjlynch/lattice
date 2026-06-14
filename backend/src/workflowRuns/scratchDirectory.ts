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
