// All WebSocket endpoints share one HTTP server. Using `{ server, path }`
// per WSS is broken: each WSS adds its own `upgrade` listener and the
// first to see a non-matching path aborts the handshake before the
// matching one runs. Solution: noServer mode + a single dispatcher that
// routes by pathname.

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import {
  ensureTerminalServer,
  proxyTerminalWs,
} from '../terminalProxy.js';
import { listTasks, subscribe as subscribeTasks } from '../tasks.js';
import {
  getActiveRunForProject,
  subscribe as subscribeMergeRuns,
} from '../mergeRuns.js';
import {
  listWorkflows,
  subscribe as subscribeWorkflows,
} from '../workflows.js';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  subscribe as subscribeWorkflowRuns,
} from '../workflowRuns.js';
import { subscribeHealth } from '../health/watcher.js';
import { canonicalProjectPath } from '../projectPath.js';

function parseProject(reqUrl: string | undefined): string {
  const url = new URL(reqUrl || '', 'http://localhost');
  const raw = url.searchParams.get('project') || '';
  return raw ? canonicalProjectPath(raw) : '';
}

function buildTerminalWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    // Self-heal: restart the terminal server if it crashed while main was running.
    await ensureTerminalServer().catch(() => {});
    proxyTerminalWs(ws, req.url ?? undefined);
  });
  return wss;
}

function buildTasksWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    const project = parseProject(req.url);
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
    const unsub = subscribeTasks((updatedProject, updatedTasks) => {
      if (updatedProject !== project) return;
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'tasks', tasks: updatedTasks }));
    });
    ws.on('close', () => unsub());
  });
  return wss;
}

function buildMergeRunsWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const project = parseProject(req.url);
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
  return wss;
}

function buildWorkflowsWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    const project = parseProject(req.url);
    if (!project) {
      ws.close();
      return;
    }
    try {
      const initial = await listWorkflows(project);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'workflows', workflows: initial }));
      }
    } catch {
      /* ignore */
    }
    const unsub = subscribeWorkflows((updatedProject, updatedWorkflows) => {
      if (updatedProject !== project) return;
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: 'workflows', workflows: updatedWorkflows }));
    });
    ws.on('close', () => unsub());
  });
  return wss;
}

function buildWorkflowRunsWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const project = parseProject(req.url);
    if (!project) {
      ws.close();
      return;
    }
    const active = getActiveWorkflowRunsForProject(project);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'hello', runs: active }));
    }
    const unsub = subscribeWorkflowRuns((ev) => {
      if (ws.readyState !== ws.OPEN) return;
      const evProject = 'run' in ev ? ev.run.projectPath : ev.projectPath;
      if (evProject !== project) return;
      ws.send(JSON.stringify(ev));
    });
    ws.on('close', () => unsub());
  });
  return wss;
}

function buildHealthWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    const project = parseProject(req.url);
    if (!project) {
      ws.close();
      return;
    }
    let unsub: (() => void) | null = null;
    try {
      unsub = await subscribeHealth(project, (update) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify(update));
      });
    } catch {
      // Watcher couldn't start — close gracefully so the client can
      // retry later instead of getting stuck on a half-open socket.
      ws.close();
      return;
    }
    ws.on('close', () => {
      if (unsub) unsub();
    });
  });
  return wss;
}

export function attachWebSockets(server: http.Server): void {
  const termWss = buildTerminalWss();
  const tasksWss = buildTasksWss();
  const mergeRunsWss = buildMergeRunsWss();
  const workflowsWss = buildWorkflowsWss();
  const workflowRunsWss = buildWorkflowRunsWss();
  const healthWss = buildHealthWss();

  const routes: Array<[string, WebSocketServer]> = [
    ['/ws/terminal', termWss],
    ['/ws/tasks', tasksWss],
    ['/ws/merge-runs', mergeRunsWss],
    ['/ws/workflows', workflowsWss],
    ['/ws/workflow-runs', workflowRunsWss],
    ['/ws/health', healthWss],
  ];

  server.on(
    'upgrade',
    (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url || '', 'http://localhost').pathname;
      const match = routes.find(([p]) => p === pathname);
      if (!match) {
        socket.destroy();
        return;
      }
      const wss = match[1];
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
  );
}
