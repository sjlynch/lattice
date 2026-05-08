// Task CRUD + the lifecycle hooks fired by the worktree's Stop hook
// (`/complete`, `/merged`, `/merge-aborted`, `/stash-resolved`) and by the
// task board UI (`/run`, `/resume`, `/merge`).
//
// Lifecycle ordering between this module and worktree.ts is the load-bearing
// part of the design — see the per-endpoint comments below.

import { Router, text as textBodyParser } from 'express';
import path from 'node:path';

const VALID_STATUSES: TaskStatus[] = [
  'backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done', 'deleted',
];

// Resolve `project` from query string first (preferred — keeps the body
// pure data) then fall back to the body. Lets shell agents put project
// in the URL where it's easy to URL-encode and stop wrestling JSON for
// it on every call.
function resolveProject(req: { query: unknown; body: unknown }): string {
  const q = req.query as Record<string, unknown> | null;
  const b = req.body as Record<string, unknown> | string | null;
  if (q && typeof q.project === 'string' && q.project) return q.project;
  if (b && typeof b === 'object' && typeof (b as Record<string, unknown>).project === 'string') {
    return (b as Record<string, string>).project;
  }
  return '';
}

// Parse a markdown body into a list of {title, description?} tasks. Each
// `# ` heading starts a new task; lines below it (until the next heading)
// are the description. Lines before the first heading are ignored.
//
// Why this exists: building a JSON array of tasks with multi-line
// descriptions in a shell is brutal — every backslash, quote, and
// newline needs escaping. A heredoc with single-quoted EOF passes
// markdown through *literally*, no escaping at all. This is the
// difference between a 5-line curl invocation and a 300-line python
// script when an agent wants to seed many tasks at once.
function parseMarkdownTasks(md: string): Array<{ title: string; description?: string }> {
  const lines = md.split(/\r?\n/);
  const out: Array<{ title: string; description: string[] }> = [];
  let current: { title: string; description: string[] } | null = null;
  for (const line of lines) {
    const heading = /^#\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) out.push(current);
      current = { title: heading[1], description: [] };
    } else if (current) {
      current.description.push(line);
    }
    // pre-heading lines are dropped intentionally
  }
  if (current) out.push(current);
  return out
    .filter((t) => t.title.trim())
    .map((t) => {
      const desc = t.description.join('\n').trim();
      return desc ? { title: t.title, description: desc } : { title: t.title };
    });
}
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
  buildCodexCommand,
  buildCodexResumeCommand,
  worktreeExists,
  isMidMerge,
  mergeWorktreeInRepo,
  finalizeMergedTask,
  writeMergeInstructions,
  buildConflictResolveCommand,
  branchCommitCount,
  cleanupWorktreeForTask,
  ensureLatticeGitignore,
  ensureLatticeRepoExclude,
  untrackOwnedFilesInRepo,
} from '../worktree.js';
import { getActiveRunForProject, startMergeRun } from '../mergeRuns.js';
import { tryAcquire, release } from '../mergeLocks.js';
import { proxyCreateSession } from '../terminalProxy.js';

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
    // Optional `?status=` filter so callers (esp. AI agents driving the API
    // from a shell) don't have to fetch the whole list and re-filter
    // client-side. Comma-separated for "open,in_progress" style queries.
    const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
    const filter = statusParam
      ? new Set(statusParam.split(',').map((s) => s.trim()).filter(Boolean))
      : null;
    try {
      const all = await listTasks(project);
      res.json(filter ? all.filter((t) => filter.has(t.status)) : all);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Counts by status — saves agents from writing a "load-then-tally" script
  // when they just want to know what's on the board.
  // MUST be registered before `/api/tasks/:id`, which would otherwise
  // capture `summary` as an :id and 404.
  r.get('/api/tasks/summary', async (req, res) => {
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    try {
      const all = await listTasks(project);
      const counts: Record<string, number> = {};
      for (const t of all) counts[t.status] = (counts[t.status] ?? 0) + 1;
      res.json({ total: all.length, byStatus: counts });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  r.get('/api/tasks/:id', async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json(task);
  });

  // Single task. Accepts JSON, form-encoded, or query-string `project`
  // — whichever is easiest to build from the agent's current shell.
  r.post('/api/tasks', async (req, res) => {
    const project = resolveProject(req);
    const body = (req.body || {}) as { title?: string; description?: string };
    const title = body.title;
    const description = body.description;
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

  // Batch-create. Accepts EITHER:
  //   - application/json: { project?, tasks: [{title, description?}, ...] }
  //     or just [{title, description?}, ...] when project is in the query.
  //   - text/markdown: each `# Heading` starts a new task, lines below
  //     it become the description. Project must be in the query string.
  //
  // Markdown is the killer ergonomics path for shell agents: a heredoc
  // with single-quoted 'EOF' passes the body through with zero escaping.
  // Returns the created tasks in declaration order.
  r.post(
    '/api/tasks/batch',
    textBodyParser({ type: 'text/markdown', limit: '1mb' }),
    async (req, res) => {
      const project = resolveProject(req);
      if (!project) {
        return res.status(400).json({ error: 'project required (query string or JSON body)' });
      }
      let parsed: Array<{ title: string; description?: string }>;
      if (typeof req.body === 'string') {
        parsed = parseMarkdownTasks(req.body);
        if (parsed.length === 0) {
          return res.status(400).json({
            error: 'no tasks parsed from markdown body — use `# Heading` lines to mark each task',
          });
        }
      } else {
        const body = (req.body || {}) as { tasks?: Array<{ title?: string; description?: string }> };
        // Allow a bare array as the body (when project comes from query).
        const arr = Array.isArray(req.body) ? req.body : body.tasks;
        if (!Array.isArray(arr) || arr.length === 0) {
          return res.status(400).json({ error: 'tasks must be a non-empty array' });
        }
        const invalid = arr.findIndex((t: { title?: string }) => !t.title?.trim());
        if (invalid !== -1) {
          return res.status(400).json({ error: `tasks[${invalid}].title is required` });
        }
        parsed = arr.map((t: { title?: string; description?: string }) => ({
          title: t.title!.trim(),
          description: t.description,
        }));
      }
      try {
        const created = await Promise.all(
          parsed.map((t) => createTask(project, t.title, t.description)),
        );
        res.json(created);
      } catch (err) {
        res.status(500).json({ error: (err as Error).message });
      }
    },
  );

  // Bulk status transition. Saves agents from N PATCH round trips when
  // they're shepherding a batch of tasks (e.g. "mark every qa task done"
  // after reviewing the lane). Either explicit `ids` OR `fromStatus` +
  // `project` to target everything in a lane. Idempotent: tasks already
  // at the target status are no-op.
  r.post('/api/tasks/transition', async (req, res) => {
    const body = (req.body || {}) as {
      ids?: string[];
      status?: TaskStatus;
      fromStatus?: TaskStatus;
    };
    const project = resolveProject(req);
    const status = body.status;
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(', ')}`,
      });
    }
    let ids: string[];
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      ids = body.ids;
    } else if (body.fromStatus && project) {
      if (!VALID_STATUSES.includes(body.fromStatus)) {
        return res.status(400).json({ error: `fromStatus must be one of: ${VALID_STATUSES.join(', ')}` });
      }
      const all = await listTasks(project);
      ids = all.filter((t) => t.status === body.fromStatus).map((t) => t.id);
    } else {
      return res.status(400).json({
        error: 'provide either { ids: [...] } or { fromStatus, project }',
      });
    }
    if (ids.length === 0) {
      return res.json({ updated: 0, missing: [], ids: [] });
    }
    try {
      const results = await Promise.all(ids.map((id) => updateTask(id, { status })));
      const updated: string[] = [];
      const missing: string[] = [];
      results.forEach((r, i) => (r ? updated.push(r.id) : missing.push(ids[i])));
      res.json({ updated: updated.length, missing, ids: updated });
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
        task.id,
        backendOrigin,
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
      // Heal the project's tracking of Lattice-owned files before merging.
      // Idempotent no-op when nothing is tracked. See untrackOwnedFilesInRepo.
      try {
        await ensureLatticeGitignore(task.projectPath);
        // See ensureLatticeRepoExclude for why this exists alongside
        // ensureLatticeGitignore — the repo-local exclude file is what
        // actually keeps `.lattice/worktrees/<id>/` (a nested git
        // checkout) out of the auto-stash that fastForwardMain runs.
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
      task.id,
      backendOrigin,
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
