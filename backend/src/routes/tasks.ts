// Task CRUD + the lifecycle hooks fired by the worktree's Stop hook
// (`/complete`, `/merged`, `/merge-aborted`, `/stash-resolved`) and by the
// task board UI (`/run`, `/resume`, `/merge`).
//
// Lifecycle ordering between this module and worktree.ts is the load-bearing
// part of the design — see the per-endpoint comments below.

import { Router } from 'express';
import path from 'node:path';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  updateTaskCrashSafe,
  deleteTask,
  reorderTasksInLane,
  type TaskStatus,
} from '../tasks.js';
import {
  setupTaskWorktree,
  buildClaudeCommand,
  buildResumeCommand,
  buildPiCommand,
  buildPiResumeCommand,
  worktreeExists,
  isMidMerge,
  mergeWorktreeInRepo,
  finalizeMergedTask,
  writeMergeInstructions,
  buildConflictResolveCommand,
  branchCommitCount,
  cleanupWorktreeForTask,
} from '../worktree.js';
import { getActiveRunForProject, startMergeRun } from '../mergeRuns.js';
import { tryAcquire, release } from '../mergeLocks.js';

// Tracks projects that currently have a per-card manual merge in flight.
// Prevents two simultaneous per-card merge clicks from racing on
// fastForwardMain (which mutates main's HEAD). The merge-run worker is
// already sequential; this guard covers the manual path.
const projectMergesActive = new Set<string>();

// finalizeMergedTask now lives in worktree.ts so it's reachable from the
// merge-run worker too. Convert its discriminated outcome to a flat
// message string for HTTP responses.
function finalizeError(
  fin: Extract<
    Awaited<ReturnType<typeof finalizeMergedTask>>,
    { ok: false }
  >,
): string {
  if ('error' in fin) return fin.error;
  return `Stash-pop conflict on ${fin.stashConflict.length} file(s) — Claude resolver spawned`;
}

export function buildTasksRouter(backendOrigin: string): Router {
  const r = Router();

  r.get('/api/tasks', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    try {
      res.json(await listTasks(project));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.get('/api/tasks/:id', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(task);
  });

  r.post('/api/tasks', async (req, res) => {
    const { project, title, description } = (req.body || {}) as {
      project?: string;
      title?: string;
      description?: string;
    };
    if (!project || !title?.trim()) {
      return res.status(400).json({ error: 'project and title required' });
    }
    try {
      const t = await createTask(project, title, description);
      res.json(t);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Batch-create: accepts { project, tasks: [{title, description?}] }.
  // Returns the created task array in the same order. Intended for workflow
  // Claude agents that produce several tasks at once — avoids N round trips
  // and N separate shell-quoting opportunities.
  r.post('/api/tasks/batch', async (req, res) => {
    const { project, tasks } = (req.body || {}) as {
      project?: string;
      tasks?: Array<{ title?: string; description?: string }>;
    };
    if (!project) return res.status(400).json({ error: 'project required' });
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'tasks must be a non-empty array' });
    }
    const invalid = tasks.findIndex((t) => !t.title?.trim());
    if (invalid !== -1) {
      return res.status(400).json({ error: `tasks[${invalid}].title is required` });
    }
    try {
      const created = await Promise.all(
        tasks.map((t) => createTask(project, t.title!, t.description)),
      );
      res.json(created);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.patch('/api/tasks/:id', async (req, res) => {
    const updates = (req.body || {}) as {
      title?: string;
      description?: string;
      status?: TaskStatus;
    };
    try {
      const updated = await updateTask(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: 'not found' });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.post('/api/tasks/reorder', async (req, res) => {
    const { project, status, ids } = (req.body || {}) as {
      project?: string;
      status?: TaskStatus;
      ids?: string[];
    };
    if (!project || !status || !Array.isArray(ids)) {
      return res.status(400).json({ error: 'project, status, ids required' });
    }
    try {
      const ok = await reorderTasksInLane(project, status, ids);
      if (!ok) return res.status(404).json({ error: 'project not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.delete('/api/tasks/:id', async (req, res) => {
    const task = await getTask(req.params.id);
    if (task && task.worktreePath && task.branch) {
      try {
        await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
      } catch {
        /* ignore — worktree may have already been removed manually */
      }
    }
    const ok = await deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  r.post('/api/tasks/:id/run', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'open') {
      return res
        .status(400)
        .json({ error: `task is "${task.status}"; only open tasks can be run` });
    }
    try {
      const result = await setupTaskWorktree(task.projectPath, task, backendOrigin);
      const harness = req.body?.harness === 'pi' ? 'pi' : 'claude';
      const command = harness === 'pi'
        ? buildPiCommand(result.taskFile)
        : buildClaudeCommand(result.taskFile);
      await updateTask(task.id, {
        status: 'in_progress',
        worktreePath: result.worktreePath,
        branch: result.branch,
        startedAt: Date.now(),
      });
      res.json({
        worktreePath: result.worktreePath,
        branch: result.branch,
        taskFile: result.taskFile,
        command,
      });
    } catch (err) {
      // Log full context before swallowing into a 500 — without this, transient
      // git failures (lock contention, stale worktree state, etc.) leave only
      // a generic toast in the UI and no trace on the server.
      console.error(
        `[run] task ${task.id} ("${task.title.slice(0, 60)}") at ${task.projectPath}: setupTaskWorktree failed:`,
        err,
      );
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Resume an in_progress task — re-spawn Claude in the existing worktree
  // with a "continue what's been started" prompt. Useful when a previous
  // Claude session ended without committing (so /complete left the task at
  // in_progress) or when the dev server was restarted mid-task.
  r.post('/api/tasks/:id/resume', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'in_progress') {
      return res.status(400).json({
        error: `task is "${task.status}"; only in_progress tasks can be resumed`,
      });
    }
    if (!task.worktreePath) {
      return res
        .status(400)
        .json({ error: 'task has no worktree path on record' });
    }
    if (!(await worktreeExists(task.worktreePath))) {
      return res.status(400).json({
        error: `Worktree directory not found at ${task.worktreePath}. The worktree may have been removed manually.`,
      });
    }
    const taskFile = path.join(task.worktreePath, 'LATTICE_TASK.md');
    const harness = req.body?.harness === 'pi' ? 'pi' : 'claude';
    const command = harness === 'pi'
      ? buildPiResumeCommand(taskFile)
      : buildResumeCommand(taskFile);
    res.json({
      worktreePath: task.worktreePath,
      branch: task.branch,
      taskFile,
      command,
    });
  });

  // Hook callback: claude finished a turn.
  //
  // Two cases handled here, both driven by the worktree's own Stop hook:
  //   in_progress -> ready_to_merge: the original task's Claude committed.
  //   ready_to_merge + conflict:    the resolver Claude finished resolving.
  r.post('/api/tasks/:id/complete', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });

    // Resolver-Claude finished. The merge in the worktree is committed;
    // fast-forward main and clean up.
    if (
      task.status === 'ready_to_merge' &&
      task.conflict &&
      task.branch &&
      task.worktreePath
    ) {
      if (await isMidMerge(task.worktreePath)) {
        // Resolver hasn't committed yet (Stop fired mid-resolution).
        console.log(
          `[complete] task ${task.id}: resolver still mid-merge, skipping FF.`,
        );
        return res.json({ ok: true, awaitingResolution: true });
      }
      // Re-sync with current main before finalizing. The merge run may have
      // advanced main (via other tasks) while the resolver was working, making
      // the branch's merge commit stale relative to main — causing --ff-only
      // to fail. Merging again absorbs those new main commits; if that also
      // conflicts we need another resolver pass.
      const reSync = await mergeWorktreeInRepo(
        task.projectPath,
        task.branch,
        task.worktreePath,
      );
      if (reSync.status === 'conflict') {
        const { relativePath } = await writeMergeInstructions(
          task,
          task.branch,
          reSync.conflictedFiles,
          backendOrigin,
          task.worktreePath,
        );
        await updateTask(task.id, { conflict: true, conflictStartedAt: Date.now() });
        console.log(
          `[complete] task ${task.id}: re-sync with main conflicted — resolver re-queued`,
        );
        return res.json({
          ok: true,
          requiresReResolution: true,
          conflictedFiles: reSync.conflictedFiles,
          command: buildConflictResolveCommand(relativePath),
          cwd: task.worktreePath,
        });
      }
      if (reSync.status === 'error') {
        console.warn(`[complete] task ${task.id}: re-sync with main failed: ${reSync.message}`);
        return res.json({ ok: false, error: reSync.message });
      }
      const fin = await finalizeMergedTask(task, backendOrigin);
      if (!fin.ok) {
        const msg = finalizeError(fin);
        console.warn(`[complete] finalize after resolution failed: ${msg}`);
        return res.json({ ok: false, error: msg });
      }
      // Auto-restart the run so any remaining ready_to_merge tasks are picked up.
      startMergeRun(task.projectPath, backendOrigin).catch(() => {});
      return res.json({ ok: true, finalized: true });
    }

    if (task.status !== 'in_progress') {
      return res.json({ ok: true });
    }
    // Only flip when there are real commits — Claude finishing without
    // committing must NOT be reported as ready to merge.
    if (task.branch && task.projectPath) {
      try {
        const commits = await branchCommitCount(task.projectPath, task.branch);
        if (commits === 0) {
          console.warn(
            `[complete] task ${task.id} (${task.title}) hit Stop hook with ` +
              `no commits on ${task.branch} — leaving at in_progress.`,
          );
          return res.json({ ok: true, awaitingCommit: true });
        }
      } catch (err) {
        console.error('[complete] branchCommitCount failed', err);
      }
    }
    await updateTask(task.id, {
      status: 'ready_to_merge',
      completedAt: Date.now(),
    });
    res.json({ ok: true });
  });

  // Initiate the merge for a ready_to_merge task.
  //   clean    -> cleanup worktree, flip task to qa
  //   conflict -> task stays at ready_to_merge with conflict=true; backend
  //               returns the resolver Claude prompt for the UI to spawn.
  r.post('/api/tasks/:id/merge', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'ready_to_merge') {
      return res.status(400).json({
        error: `task is "${task.status}"; only ready_to_merge tasks can be merged`,
      });
    }
    if (!task.branch || !task.worktreePath) {
      return res
        .status(400)
        .json({ error: 'task has no worktree branch on record' });
    }

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

    if (!tryAcquire(task.id)) {
      return res
        .status(409)
        .json({ error: 'merge already in progress for this task' });
    }

    projectMergesActive.add(task.projectPath);

    try {
      // If already in a known conflict state, return the existing instructions
      // rather than re-running git merge (which would refuse anyway).
      if (task.conflict) {
        const { relativePath } = await writeMergeInstructions(
          task,
          task.branch,
          [],
          backendOrigin,
          task.worktreePath,
        );
        return res.json({
          merged: false,
          conflict: true,
          command: buildConflictResolveCommand(relativePath),
          cwd: task.worktreePath,
        });
      }

      const result = await mergeWorktreeInRepo(
        task.projectPath,
        task.branch,
        task.worktreePath,
      );
      if (result.status === 'clean') {
        const fin = await finalizeMergedTask(task, backendOrigin);
        if (!fin.ok) {
          if ('stashConflict' in fin) {
            return res.json({
              merged: false,
              stashConflict: true,
              command: fin.resolveCommand,
              cwd: fin.cwd,
              conflictedFiles: fin.stashConflict,
            });
          }
          return res.status(500).json({ error: finalizeError(fin) });
        }
        return res.json({ merged: true });
      }
      if (result.status === 'conflict') {
        const { relativePath } = await writeMergeInstructions(
          task,
          task.branch,
          result.conflictedFiles,
          backendOrigin,
          task.worktreePath,
        );
        await updateTask(task.id, {
          conflict: true,
          conflictStartedAt: Date.now(),
        });
        return res.json({
          merged: false,
          conflict: true,
          command: buildConflictResolveCommand(relativePath),
          cwd: task.worktreePath,
          conflictedFiles: result.conflictedFiles,
        });
      }
      return res.status(500).json({ error: result.message });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    } finally {
      release(task.id);
      projectMergesActive.delete(task.projectPath);
    }
  });

  // Resolver Claude reports it has finished the merge → ready_to_merge → qa.
  // Idempotent: duplicates after the task has already moved are a no-op.
  r.post('/api/tasks/:id/merged', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.status !== 'ready_to_merge') {
      return res.json({ ok: true });
    }
    if (!task.branch || !task.worktreePath) {
      return res.status(400).json({ error: 'task missing worktree info' });
    }
    if (await isMidMerge(task.worktreePath)) {
      return res
        .status(400)
        .json({ error: 'worktree is still mid-merge — commit first.' });
    }
    // Re-sync with current main (same reason as /complete — see comment there).
    const reSync = await mergeWorktreeInRepo(
      task.projectPath,
      task.branch,
      task.worktreePath,
    );
    if (reSync.status === 'conflict') {
      const { relativePath } = await writeMergeInstructions(
        task,
        task.branch,
        reSync.conflictedFiles,
        backendOrigin,
        task.worktreePath,
      );
      await updateTask(task.id, { conflict: true, conflictStartedAt: Date.now() });
      return res.status(409).json({
        error: 'Re-sync with main introduced new conflicts — another resolver needed',
        command: buildConflictResolveCommand(relativePath),
        cwd: task.worktreePath,
        conflictedFiles: reSync.conflictedFiles,
      });
    }
    if (reSync.status === 'error') {
      return res.status(500).json({ error: `Re-sync with main failed: ${reSync.message}` });
    }
    const fin = await finalizeMergedTask(task, backendOrigin);
    if (!fin.ok) {
      return res.status(500).json({ error: finalizeError(fin) });
    }
    startMergeRun(task.projectPath, backendOrigin).catch(() => {});
    res.json({ ok: true });
  });

  // Resolver Claude gave up (after `git merge --abort`). Clear the in-flight
  // flag so the user can retry the merge.
  r.post('/api/tasks/:id/merge-aborted', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    await updateTask(task.id, {
      conflict: undefined,
      conflictStartedAt: undefined,
    });
    res.json({ ok: true });
  });

  // Claude resolved a stash-pop conflict in the main repo. Finish cleanup
  // and auto-restart the merge run for any remaining ready_to_merge tasks.
  r.post('/api/tasks/:id/stash-resolved', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.worktreePath && task.branch) {
      try {
        await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
      } catch {
        /* ignore — worktree may have already been removed */
      }
    }
    await updateTaskCrashSafe(task.id, {
      status: 'qa',
      mergedAt: Date.now(),
      worktreePath: undefined,
      branch: undefined,
      conflict: undefined,
      conflictStartedAt: undefined,
    });
    // Auto-restart merge run for any remaining ready_to_merge tasks.
    startMergeRun(task.projectPath, backendOrigin).catch(() => {
      /* throws if a run is already active or there are no remaining tasks — both fine */
    });
    res.json({ ok: true });
  });

  return r;
}
