import express from 'express';
// Monkey-patches Express 4 to forward async-handler rejections to the
// error middleware below, so a route that throws never returns a generic
// non-JSON 500 — the toast always has a real message to show.
import 'express-async-errors';
import cors from 'cors';

// Last-resort process-level guards.
//
// node-pty on Windows has a known bug in its cleanup path: when a pty is
// killed and the conpty_console_list_agent helper subprocess fails to
// AttachConsole (which happens routinely on Windows shells that have
// already exited), node-pty's main code does
//   consoleProcessList.forEach(...)
// at windowsPtyAgent.js:141 with consoleProcessList === undefined. The
// throw fires asynchronously past any try/catch around pty.kill(), so it
// surfaces as an uncaughtException and crashes the whole backend — taking
// every other terminal session with it. The pty itself does die fine; the
// failed cleanup is purely cosmetic. Swallow only node-pty errors here so
// real bugs still surface.
process.on('uncaughtException', (err) => {
  const stack = err instanceof Error && err.stack ? err.stack : String(err);
  if (stack.includes('node-pty')) {
    console.warn(
      '[lattice] swallowed node-pty error (pty cleanup, not fatal):',
      err instanceof Error ? err.message : err,
    );
    return;
  }
  console.error('[lattice] uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  const stack =
    reason instanceof Error && reason.stack ? reason.stack : String(reason);
  if (stack.includes('node-pty')) {
    console.warn(
      '[lattice] swallowed node-pty rejection:',
      reason instanceof Error ? reason.message : reason,
    );
    return;
  }
  console.error('[lattice] unhandledRejection', reason);
});
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { scan } from './scanner.js';
import { listDir } from './fsbrowse.js';
import {
  ensureTerminalServer,
  proxyTerminalWs,
  proxyListSessions,
  proxyKillSession,
} from './terminalProxy.js';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  reorderTasksInLane,
  subscribe,
  flushPersist,
  type TaskStatus,
} from './tasks.js';
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
} from './worktree.js';
import {
  startMergeRun,
  cancelRun,
  getRun,
  getActiveRunForProject,
  subscribe as subscribeMergeRuns,
} from './mergeRuns.js';
import { tryAcquire, release } from './mergeLocks.js';

// Tracks projects that currently have a per-card manual merge in flight.
// Prevents two simultaneous per-card merge clicks from racing on
// fastForwardMain (which mutates main's HEAD). The merge-run worker is
// already sequential; this guard covers the manual path.
const projectMergesActive = new Set<string>();
import { getUserSettings, patchUserSettings, type UserSettings } from './userSettings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5184;
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_ORIGIN = `http://127.0.0.1:${PORT}`;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/default-root', (_req, res) => {
  res.json({ path: DEFAULT_ROOT });
});

app.get('/api/scan', async (req, res) => {
  const target =
    typeof req.query.path === 'string' ? req.query.path : DEFAULT_ROOT;
  try {
    const result = await scan(target);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/terminals', async (_req, res) => {
  res.json(await proxyListSessions());
});

app.delete('/api/terminals/:id', async (req, res) => {
  const ok = await proxyKillSession(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/api/list-dir', async (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : undefined;
  try {
    const result = await listDir(target);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------- User settings ----------

app.get('/api/settings', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) return res.status(400).json({ error: 'project required' });
  res.json(await getUserSettings(project));
});

app.patch('/api/settings', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) return res.status(400).json({ error: 'project required' });
  const partial = (req.body || {}) as Partial<UserSettings>;
  res.json(await patchUserSettings(project, partial));
});

// ---------- Tasks ----------

app.get('/api/tasks', async (req, res) => {
  const project = typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) return res.status(400).json({ error: 'project required' });
  try {
    res.json(await listTasks(project));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get('/api/tasks/:id', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task);
});

app.post('/api/tasks', async (req, res) => {
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

app.patch('/api/tasks/:id', async (req, res) => {
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

app.post('/api/tasks/reorder', async (req, res) => {
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

app.delete('/api/tasks/:id', async (req, res) => {
  const ok = await deleteTask(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status !== 'open') {
    return res
      .status(400)
      .json({ error: `task is "${task.status}"; only open tasks can be run` });
  }
  try {
    const result = await setupTaskWorktree(task.projectPath, task, BACKEND_ORIGIN);
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
    res.status(500).json({ error: (err as Error).message });
  }
});

// Resume an in_progress task — re-spawn Claude in the existing worktree
// with a "continue what's been started" prompt. Useful when a previous
// Claude session ended without committing (so /complete left the task at
// in_progress) or when the dev server was restarted mid-task.
app.post('/api/tasks/:id/resume', async (req, res) => {
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

// Hook callback: claude finished a turn.
//
// Two cases handled here, both driven by the worktree's own Stop hook:
//   in_progress -> ready_to_merge: the original task's Claude committed.
//   ready_to_merge + conflict:    the resolver Claude finished resolving.
app.post('/api/tasks/:id/complete', async (req, res) => {
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
    const fin = await finalizeMergedTask(task, BACKEND_ORIGIN);
    if (!fin.ok) {
      const msg = finalizeError(fin);
      console.warn(`[complete] finalize after resolution failed: ${msg}`);
      return res.json({ ok: false, error: msg });
    }
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
app.post('/api/tasks/:id/merge', async (req, res) => {
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
        BACKEND_ORIGIN,
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
      const fin = await finalizeMergedTask(task, BACKEND_ORIGIN);
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
        BACKEND_ORIGIN,
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
app.post('/api/tasks/:id/merged', async (req, res) => {
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
  const fin = await finalizeMergedTask(task, BACKEND_ORIGIN);
  if (!fin.ok) {
    return res.status(500).json({ error: finalizeError(fin) });
  }
  res.json({ ok: true });
});

// Resolver Claude gave up (after `git merge --abort`). Clear the in-flight
// flag so the user can retry the merge.
app.post('/api/tasks/:id/merge-aborted', async (req, res) => {
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
app.post('/api/tasks/:id/stash-resolved', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.worktreePath && task.branch) {
    try {
      await cleanupWorktreeForTask(task.projectPath, task.worktreePath, task.branch);
    } catch {
      /* ignore — worktree may have already been removed */
    }
  }
  await updateTask(task.id, {
    status: 'qa',
    mergedAt: Date.now(),
    worktreePath: undefined,
    branch: undefined,
    conflict: undefined,
    conflictStartedAt: undefined,
  });
  await flushPersist(task.projectPath);
  // Auto-restart merge run for any remaining ready_to_merge tasks.
  startMergeRun(task.projectPath, BACKEND_ORIGIN).catch(() => {
    /* throws if a run is already active or there are no remaining tasks — both fine */
  });
  res.json({ ok: true });
});

// ---------- Merge runs (backend-driven merge-all) ----------

app.post('/api/merge-runs', async (req, res) => {
  const project =
    typeof req.body?.project === 'string' && req.body.project
      ? req.body.project
      : '';
  if (!project) return res.status(400).json({ error: 'project required' });
  try {
    const run = await startMergeRun(project, BACKEND_ORIGIN);
    res.json(run);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

app.get('/api/merge-runs/active', (req, res) => {
  const project =
    typeof req.query.project === 'string' ? req.query.project : '';
  if (!project) return res.status(400).json({ error: 'project required' });
  res.json(getActiveRunForProject(project));
});

app.get('/api/merge-runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

app.post('/api/merge-runs/:id/cancel', (req, res) => {
  const ok = cancelRun(req.params.id);
  if (!ok) return res.status(404).json({ error: 'no active run with that id' });
  res.json({ ok: true });
});

// ---------- Global JSON error middleware ----------
//
// Last route (Express convention: 4-arg handler is treated as error
// middleware). Catches:
//   - thrown sync errors from any handler
//   - rejected promises from async handlers (via express-async-errors)
//   - explicit next(err) calls
// Always responds with `{error: "..."}` so the frontend's asJson() helper
// can extract a useful message into the toast instead of falling back to
// a bare "500".
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error('[lattice] route error', err);
    if (res.headersSent) return next(err);
    const message =
      err instanceof Error && err.message ? err.message : String(err);
    res.status(500).json({ error: message });
  },
);

// ---------- WebSockets ----------
//
// Two WS endpoints share one HTTP server. Using `{ server, path }` for both
// is broken: each WSS adds its own `upgrade` listener and the first one to
// see a non-matching path aborts the handshake before the matching one runs.
// Solution: noServer mode + a single dispatcher.

const server = http.createServer(app);

const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', async (ws, req) => {
  // Self-heal: restart the terminal server if it crashed while main was running.
  await ensureTerminalServer().catch(() => {});
  proxyTerminalWs(ws, req.url ?? undefined);
});

const tasksWss = new WebSocketServer({ noServer: true });
tasksWss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  const project = url.searchParams.get('project') || '';
  if (!project) {
    ws.close();
    return;
  }
  try {
    const initial = await listTasks(project);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'tasks', tasks: initial }));
    }
  } catch {
    /* ignore */
  }
  const unsub = subscribe((updatedProject, updatedTasks) => {
    if (updatedProject !== project) return;
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'tasks', tasks: updatedTasks }));
  });
  ws.on('close', () => unsub());
});

const mergeRunsWss = new WebSocketServer({ noServer: true });
mergeRunsWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  const project = url.searchParams.get('project') || '';
  if (!project) {
    ws.close();
    return;
  }
  // Always send current state on connect so the UI re-syncs after a WS
  // reconnect. If no run is active, send 'idle' so the client can clear
  // any stale run state it was showing before the connection dropped.
  const active = getActiveRunForProject(project);
  if (ws.readyState === ws.OPEN) {
    ws.send(
      JSON.stringify(active ? { type: 'started', run: active } : { type: 'idle' }),
    );
  }
  const unsub = subscribeMergeRuns((ev) => {
    if (ws.readyState !== ws.OPEN) return;
    // Filter to events for this project.
    const evProject =
      'run' in ev ? ev.run.projectPath : ev.projectPath;
    if (evProject !== project) return;
    ws.send(JSON.stringify(ev));
  });
  ws.on('close', () => unsub());
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '', 'http://localhost').pathname;
  if (pathname === '/ws/terminal') {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/tasks') {
    tasksWss.handleUpgrade(req, socket, head, (ws) => {
      tasksWss.emit('connection', ws, req);
    });
  } else if (pathname === '/ws/merge-runs') {
    mergeRunsWss.handleUpgrade(req, socket, head, (ws) => {
      mergeRunsWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

async function start() {
  await ensureTerminalServer();
  server.listen(PORT, () => {
    console.log(`[lattice-backend] listening on http://localhost:${PORT}`);
    console.log(`[lattice-backend] default root: ${DEFAULT_ROOT}`);
  });
}

start().catch((err) => {
  console.error('[lattice-backend] startup error:', err);
  process.exit(1);
});
