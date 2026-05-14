import { Router, type Response } from 'express';
import { getTask, type Task } from '../../tasks.js';
import {
  isMidMerge,
  writeMergeInstructions,
  buildConflictResolveCommand,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
  resyncWithMainAndFinalize,
  type ResyncOutcome,
} from '../../worktree.js';
import { getActiveRunForProject } from '../../mergeRuns.js';
import { tryAcquire, release } from '../../mergeLocks.js';
import { proxyCreateSession } from '../../terminalProxy.js';
import {
  acquireProjectRunLock,
  ProjectRunLockedError,
} from '../../projectRunLock.js';
import { logTaskRouteError, requireTaskStatus } from './_shared.js';

// Tracks projects that currently have a per-card manual merge in flight.
// Prevents two simultaneous per-card merge clicks from racing on
// fastForwardMain (which mutates main's HEAD). The merge-run worker is
// already sequential; this guard covers the manual path.
const projectMergesActive = new Set<string>();

type MergeLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

async function withMergeLock<T>(
  taskId: string,
  callback: () => Promise<T>,
): Promise<MergeLockResult<T>> {
  if (!tryAcquire(taskId)) return { acquired: false };

  try {
    return { acquired: true, value: await callback() };
  } finally {
    release(taskId);
  }
}

type MergeReadyTask = Task & { branch: string; worktreePath: string };

async function respondResolverSession(
  res: Response,
  task: MergeReadyTask,
  payload: {
    stashConflict?: true;
    command: string;
    cwd: string;
    conflictedFiles?: string[];
  },
) {
  const sess = await proxyCreateSession({
    cwd: payload.cwd,
    initialCommand: payload.command,
    projectPath: task.projectPath,
  });
  if (payload.stashConflict) {
    return res.json({
      merged: false,
      stashConflict: true,
      command: payload.command,
      cwd: payload.cwd,
      conflictedFiles: payload.conflictedFiles,
      serverId: 'id' in sess ? sess.id : undefined,
    });
  }
  if (payload.conflictedFiles) {
    return res.json({
      merged: false,
      conflict: true,
      command: payload.command,
      cwd: payload.cwd,
      conflictedFiles: payload.conflictedFiles,
      serverId: 'id' in sess ? sess.id : undefined,
    });
  }
  return res.json({
    merged: false,
    conflict: true,
    command: payload.command,
    cwd: payload.cwd,
    serverId: 'id' in sess ? sess.id : undefined,
  });
}

async function respondMergeOutcome(
  res: Response,
  task: MergeReadyTask,
  outcome: ResyncOutcome,
) {
  if (outcome.kind === 'finalized') {
    return res.json({ merged: true });
  }
  if (outcome.kind === 'stash-conflict') {
    return respondResolverSession(res, task, {
      stashConflict: true,
      command: outcome.resolveCommand,
      cwd: outcome.cwd,
      conflictedFiles: outcome.conflictedFiles,
    });
  }
  if (outcome.kind === 'merge-conflict') {
    return respondResolverSession(res, task, {
      command: outcome.command,
      cwd: outcome.cwd,
      conflictedFiles: outcome.conflictedFiles,
    });
  }
  return res.status(500).json({ error: outcome.message });
}

async function respondExistingConflictInstructions(
  res: Response,
  task: MergeReadyTask,
  backendOrigin: string,
) {
  const { relativePath } = await writeMergeInstructions(
    task,
    task.branch,
    [],
    backendOrigin,
    task.worktreePath,
  );
  return respondResolverSession(res, task, {
    command: buildConflictResolveCommand(relativePath),
    cwd: task.worktreePath,
  });
}

async function handleAlreadyConflictedMerge(
  task: MergeReadyTask,
  backendOrigin: string,
  res: Response,
) {
  if (!(await isMidMerge(task.worktreePath))) {
    const outcome = await resyncWithMainAndFinalize(task, backendOrigin);
    // A re-sync error here falls back to returning the existing resolver
    // instructions, matching the old manual /merge behavior.
    if (!(outcome.kind === 'error' && outcome.phase === 'merge')) {
      return respondMergeOutcome(res, task, outcome);
    }
  }
  return respondExistingConflictInstructions(res, task, backendOrigin);
}

async function runFreshMerge(
  task: MergeReadyTask,
  backendOrigin: string,
  res: Response,
) {
  const outcome = await resyncWithMainAndFinalize(task, backendOrigin);
  return respondMergeOutcome(res, task, outcome);
}

export function buildTaskMergeRoute(backendOrigin: string): Router {
  const r = Router();

  // Initiate the merge for a ready_to_merge task.
  //   clean    -> cleanup worktree, flip task to qa
  //   conflict -> task stays at ready_to_merge with conflict=true; backend
  //               returns the resolver Claude prompt for the UI to spawn.
  r.post('/api/tasks/:id/merge', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (!requireTaskStatus(task, 'ready_to_merge', res)) return;
    if (!task.branch || !task.worktreePath) {
      return res
        .status(400)
        .json({ error: 'task has no worktree branch on record' });
    }
    const mergeTask = task as Task & { branch: string; worktreePath: string };

    if (getActiveRunForProject(task.projectPath)) {
      return res.status(409).json({
        error: 'A merge run is in progress for this project — wait for it to finish.',
      });
    }
    if (projectMergesActive.has(task.projectPath)) {
      return res.status(409).json({
        error: 'Another merge is already in progress for this project — wait a moment and retry.',
      });
    }

    const lockResult = await withMergeLock(task.id, async () => {
      const task = mergeTask;

      // Cross-process lock: another Lattice process (e.g. the user opened
      // this project in two Lattice instances, or has Lattice running on
      // its own repo while a sibling project is merging) could otherwise
      // race us through git status / snapshot / FF. The in-process gates
      // above only see this process's state.
      let projectLock;
      try {
        projectLock = await acquireProjectRunLock(task.projectPath, 'manual-merge');
      } catch (err) {
        if (err instanceof ProjectRunLockedError) {
          return res.status(409).json({ error: err.message });
        }
        return res.status(500).json({ error: (err as Error).message });
      }

      projectMergesActive.add(task.projectPath);

      try {
        // Heal the project's tracking of Lattice-owned files before merging.
        // Idempotent no-op when nothing is tracked. See untrackOwnedFilesInRepo.
        //
        // Deliberately NO ensureLatticeGitignore call here — modifying the
        // tracked .gitignore mid-merge dirties the working tree and (as the
        // 2026-05-08/09 incident postmortems showed) creates a path where a
        // lost stash can silently delete .git/, .lattice/tasks.json, etc.
        // setupTaskWorktree applies the .gitignore once per project at
        // worktree-create time, so it's already in place by the time the
        // user clicks Merge.
        try {
          await ensureLatticeRepoExclude(task.projectPath);
          await untrackOwnedFilesInRepo(task.projectPath);
        } catch (err) {
          console.warn('[merge] pre-flight untrack failed (continuing):', err);
        }

        // If already in a known conflict state, check whether the conflict was
        // already committed. When a resolver Claude finishes but
        // finalizeMergedTask fails (e.g. a race where another task's finalize
        // ran first and advanced main), the worktree has a clean merge commit
        // but the task is still at ready_to_merge + conflict: true. Detect
        // this by checking isMidMerge: if the worktree is NOT mid-merge, the
        // resolver already committed — re-sync with current main and finalize.
        if (task.conflict) {
          return handleAlreadyConflictedMerge(task, backendOrigin, res);
        }

        return runFreshMerge(task, backendOrigin, res);
      } catch (err) {
        logTaskRouteError(task, 'merge', err);
        return res.status(500).json({ error: (err as Error).message });
      } finally {
        projectMergesActive.delete(task.projectPath);
        await projectLock.release();
      }
    });

    if (!lockResult.acquired) {
      return res
        .status(409)
        .json({ error: 'merge already in progress for this task' });
    }
    return lockResult.value;
  });

  return r;
}
