// Run / resume / merge orchestration endpoints. These spawn worktrees,
// build harness commands (claude/pi/codex), pre-create pty sessions, and
// acquire merge locks.

import { Router } from 'express';
import path from 'node:path';
import {
  getTask,
  updateTask,
} from '../../tasks.js';
import {
  setupTaskWorktree,
  buildClaudeCommand,
  buildResumeCommand,
  buildPiCommand,
  buildPiResumeCommand,
  buildCodexCommand,
  buildCodexResumeCommand,
  worktreeExists,
  isMidMerge,
  mergeWorktreeInRepo,
  finalizeMergedTask,
  writeMergeInstructions,
  buildConflictResolveCommand,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
} from '../../worktree.js';
import { getActiveRunForProject } from '../../mergeRuns.js';
import { tryAcquire, release } from '../../mergeLocks.js';
import { proxyCreateSession } from '../../terminalProxy.js';
import { finalizeError } from './_shared.js';

// Tracks projects that currently have a per-card manual merge in flight.
// Prevents two simultaneous per-card merge clicks from racing on
// fastForwardMain (which mutates main's HEAD). The merge-run worker is
// already sequential; this guard covers the manual path.
const projectMergesActive = new Set<string>();

export function buildTaskRunRouter(backendOrigin: string): Router {
  const r = Router();

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
      const reqHarness = req.body?.harness;
      const harness: 'claude' | 'pi' | 'codex' =
        reqHarness === 'pi' || reqHarness === 'codex' ? reqHarness : 'claude';
      const command =
        harness === 'pi'
          ? buildPiCommand(result.taskFile)
          : harness === 'codex'
          ? buildCodexCommand(result.taskFile)
          : buildClaudeCommand(result.taskFile);
      await updateTask(task.id, {
        status: 'in_progress',
        worktreePath: result.worktreePath,
        branch: result.branch,
        startedAt: Date.now(),
      });
      // Pre-spawn the pty so the frontend can lazy-mount its terminal pane
      // (and avoid burning a WebGL context per task at "Run All" time).
      const sess = await proxyCreateSession({
        cwd: result.worktreePath,
        initialCommand: command,
        projectPath: task.projectPath,
      });
      if ('error' in sess) {
        console.warn(`[run] task ${task.id}: pre-spawn failed: ${sess.error}`);
      }
      res.json({
        worktreePath: result.worktreePath,
        branch: result.branch,
        taskFile: result.taskFile,
        command,
        serverId: 'id' in sess ? sess.id : undefined,
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
    const reqHarness = req.body?.harness;
    const harness: 'claude' | 'pi' | 'codex' =
      reqHarness === 'pi' || reqHarness === 'codex' ? reqHarness : 'claude';
    const command =
      harness === 'pi'
        ? buildPiResumeCommand(taskFile)
        : harness === 'codex'
        ? buildCodexResumeCommand(taskFile)
        : buildResumeCommand(taskFile);
    const sess = await proxyCreateSession({
      cwd: task.worktreePath,
      initialCommand: command,
      projectPath: task.projectPath,
    });
    if ('error' in sess) {
      console.warn(`[resume] task ${task.id}: pre-spawn failed: ${sess.error}`);
    }
    res.json({
      worktreePath: task.worktreePath,
      branch: task.branch,
      taskFile,
      command,
      serverId: 'id' in sess ? sess.id : undefined,
    });
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
        if (task.worktreePath && !(await isMidMerge(task.worktreePath))) {
          const reSync = await mergeWorktreeInRepo(
            task.projectPath,
            task.branch,
            task.worktreePath,
            task.id,
            backendOrigin,
            task.title,
          );
          if (reSync.status === 'clean') {
            const fin = await finalizeMergedTask(task, backendOrigin);
            if (fin.ok) {
              return res.json({ merged: true });
            }
            if ('stashConflict' in fin) {
              const sess = await proxyCreateSession({
                cwd: fin.cwd,
                initialCommand: fin.resolveCommand,
                projectPath: task.projectPath,
              });
              return res.json({
                merged: false,
                stashConflict: true,
                command: fin.resolveCommand,
                cwd: fin.cwd,
                conflictedFiles: fin.stashConflict,
                serverId: 'id' in sess ? sess.id : undefined,
              });
            }
            return res.status(500).json({ error: finalizeError(fin) });
          }
          if (reSync.status === 'conflict') {
            const { relativePath } = await writeMergeInstructions(
              task,
              task.branch,
              reSync.conflictedFiles,
              backendOrigin,
              task.worktreePath,
            );
            await updateTask(task.id, { conflict: true, conflictStartedAt: Date.now() });
            const command = buildConflictResolveCommand(relativePath);
            const sess = await proxyCreateSession({
              cwd: task.worktreePath,
              initialCommand: command,
              projectPath: task.projectPath,
            });
            return res.json({
              merged: false,
              conflict: true,
              command,
              cwd: task.worktreePath,
              conflictedFiles: reSync.conflictedFiles,
              serverId: 'id' in sess ? sess.id : undefined,
            });
          }
          // reSync returned an error — fall through to returning existing
          // resolver instructions so the user can retry manually
        }
        const { relativePath } = await writeMergeInstructions(
          task,
          task.branch,
          [],
          backendOrigin,
          task.worktreePath,
        );
        const command = buildConflictResolveCommand(relativePath);
        const sess = await proxyCreateSession({
          cwd: task.worktreePath,
          initialCommand: command,
          projectPath: task.projectPath,
        });
        return res.json({
          merged: false,
          conflict: true,
          command,
          cwd: task.worktreePath,
          serverId: 'id' in sess ? sess.id : undefined,
        });
      }

      const result = await mergeWorktreeInRepo(
        task.projectPath,
        task.branch,
        task.worktreePath,
        task.id,
        backendOrigin,
        task.title,
      );
      if (result.status === 'clean') {
        const fin = await finalizeMergedTask(task, backendOrigin);
        if (!fin.ok) {
          if ('stashConflict' in fin) {
            const sess = await proxyCreateSession({
              cwd: fin.cwd,
              initialCommand: fin.resolveCommand,
              projectPath: task.projectPath,
            });
            return res.json({
              merged: false,
              stashConflict: true,
              command: fin.resolveCommand,
              cwd: fin.cwd,
              conflictedFiles: fin.stashConflict,
              serverId: 'id' in sess ? sess.id : undefined,
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
        const command = buildConflictResolveCommand(relativePath);
        const sess = await proxyCreateSession({
          cwd: task.worktreePath,
          initialCommand: command,
          projectPath: task.projectPath,
        });
        return res.json({
          merged: false,
          conflict: true,
          command,
          cwd: task.worktreePath,
          conflictedFiles: result.conflictedFiles,
          serverId: 'id' in sess ? sess.id : undefined,
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

  return r;
}
