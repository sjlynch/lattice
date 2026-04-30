import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { scan } from './scanner.js';
import { listDir } from './fsbrowse.js';
import { attachTerminal } from './terminal.js';
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  subscribe,
  type TaskStatus,
} from './tasks.js';
import { setupTaskWorktree, buildClaudeCommand } from './worktree.js';

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

app.get('/api/list-dir', async (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : undefined;
  try {
    const result = await listDir(target);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
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
    const command = buildClaudeCommand(result.taskFile);
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

// Hook callback: claude finished a turn → move in_progress → qa
app.post('/api/tasks/:id/complete', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.status === 'in_progress') {
    await updateTask(task.id, { status: 'qa', completedAt: Date.now() });
  }
  res.json({ ok: true });
});

// ---------- WebSockets ----------
//
// Two WS endpoints share one HTTP server. Using `{ server, path }` for both
// is broken: each WSS adds its own `upgrade` listener and the first one to
// see a non-matching path aborts the handshake before the matching one runs.
// Solution: noServer mode + a single dispatcher.

const server = http.createServer(app);

const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  const cwd = url.searchParams.get('cwd') || undefined;
  const cols = Number(url.searchParams.get('cols')) || 80;
  const rows = Number(url.searchParams.get('rows')) || 24;
  attachTerminal(ws, { cwd, cols, rows });
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
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[lattice-backend] listening on http://localhost:${PORT}`);
  console.log(`[lattice-backend] default root: ${DEFAULT_ROOT}`);
});
