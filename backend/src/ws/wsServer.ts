// All WebSocket endpoints share one HTTP server. Using `{ server, path }`
// per WSS is broken: each WSS adds its own `upgrade` listener and the
// first to see a non-matching path aborts the handshake before the
// matching one runs. Solution: noServer mode + a single dispatcher that
// routes by pathname.

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ensureTerminalServer,
  proxyTerminalWs,
} from '../terminalProxy.js';
import { detectHarnesses } from '../harnessDetect.js';
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
import { subscribeHealth, type HealthUpdate } from '../health/watcher.js';
import { canonicalProjectPath } from '../projectPath.js';

function parseProject(reqUrl: string | undefined): string {
  const url = new URL(reqUrl || '', 'http://localhost');
  const raw = url.searchParams.get('project') || '';
  return raw ? canonicalProjectPath(raw) : '';
}

type Unsubscribe = () => void;
type MaybePromise<T> = T | Promise<T>;
type ProjectEventListener<TEvent> = (event: TEvent) => void;
type ProjectRunEvent =
  | { run: { projectPath: string } }
  | { projectPath: string };

type ProjectWsOptions<TEvent> = {
  initial?: (project: string) => MaybePromise<unknown | void>;
  initialError?: 'close' | 'ignore';
  subscribe: (
    listener: ProjectEventListener<TEvent>,
    project: string,
  ) => MaybePromise<Unsubscribe>;
  projectFromEvent?: (event: TEvent) => string;
  payloadFromEvent?: (event: TEvent) => unknown;
};

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function projectFromRunEvent(ev: ProjectRunEvent): string {
  return 'run' in ev ? ev.run.projectPath : ev.projectPath;
}

function buildProjectWss<TEvent>(options: ProjectWsOptions<TEvent>): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const project = parseProject(req.url);
    if (!project) {
      ws.close();
      return;
    }

    let unsub: Unsubscribe | null = null;
    let closed = false;
    ws.on('close', () => {
      closed = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
    });

    const attach = async () => {
      if (options.initial) {
        try {
          const payload = await options.initial(project);
          if (payload !== undefined) sendJson(ws, payload);
        } catch {
          if (options.initialError !== 'ignore') {
            ws.close();
            return;
          }
        }
      }

      let nextUnsub: Unsubscribe;
      try {
        nextUnsub = await options.subscribe((event) => {
          if (options.projectFromEvent && options.projectFromEvent(event) !== project) {
            return;
          }
          sendJson(
            ws,
            options.payloadFromEvent ? options.payloadFromEvent(event) : event,
          );
        }, project);
      } catch {
        ws.close();
        return;
      }

      if (closed || ws.readyState !== ws.OPEN) {
        nextUnsub();
        return;
      }
      unsub = nextUnsub;
    };

    attach().catch(() => {
      ws.close();
    });
  });
  return wss;
}

function buildProjectSnapshotWss<TSnapshot>(options: {
  messageType: string;
  snapshotKey: string;
  list: (project: string) => MaybePromise<TSnapshot>;
  subscribe: (
    listener: (project: string, snapshot: TSnapshot) => void,
  ) => Unsubscribe;
}): WebSocketServer {
  return buildProjectWss<{ projectPath: string; snapshot: TSnapshot }>({
    initial: async (project) => ({
      type: options.messageType,
      [options.snapshotKey]: await options.list(project),
    }),
    initialError: 'ignore',
    subscribe: (listener) => options.subscribe((projectPath, snapshot) => {
      listener({ projectPath, snapshot });
    }),
    projectFromEvent: (event) => event.projectPath,
    payloadFromEvent: (event) => ({
      type: options.messageType,
      [options.snapshotKey]: event.snapshot,
    }),
  });
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
  return buildProjectSnapshotWss({
    messageType: 'tasks',
    snapshotKey: 'tasks',
    list: listTasks,
    subscribe: subscribeTasks,
  });
}

function buildMergeRunsWss(): WebSocketServer {
  return buildProjectWss<ProjectRunEvent>({
    // Always send current state on connect so the UI re-syncs after a WS
    // reconnect. If no run is active, send 'idle' so the client can clear
    // any stale run state it was showing before the connection dropped.
    initial: (project) => {
      const active = getActiveRunForProject(project);
      return active ? { type: 'started', run: active } : { type: 'idle' };
    },
    subscribe: (listener) => subscribeMergeRuns(listener),
    projectFromEvent: projectFromRunEvent,
  });
}

function buildWorkflowsWss(): WebSocketServer {
  return buildProjectSnapshotWss({
    messageType: 'workflows',
    snapshotKey: 'workflows',
    list: listWorkflows,
    subscribe: subscribeWorkflows,
  });
}

function buildWorkflowRunsWss(): WebSocketServer {
  return buildProjectWss<ProjectRunEvent>({
    initial: (project) => ({
      type: 'hello',
      runs: getActiveWorkflowRunsForProject(project),
    }),
    subscribe: (listener) => subscribeWorkflowRuns(listener),
    projectFromEvent: projectFromRunEvent,
  });
}

function buildHealthWss(): WebSocketServer {
  return buildProjectWss<HealthUpdate>({
    subscribe: (listener, project) => subscribeHealth(project, listener),
  });
}

// Push harness availability once detection completes. Lets the UI render
// the Pi/Codex/Interleave options as soon as the backend knows, even when
// the frontend was loaded before the server finished booting — the WS
// auto-reconnects, so the eventual `detectHarnesses()` resolution reaches
// the client without a manual refresh.
function buildHarnessesWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    detectHarnesses()
      .then((avail) => {
        sendJson(ws, avail);
      })
      .catch(() => { /* leave client on its default */ });
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
  const harnessesWss = buildHarnessesWss();

  const routes: Array<[string, WebSocketServer]> = [
    ['/ws/terminal', termWss],
    ['/ws/tasks', tasksWss],
    ['/ws/merge-runs', mergeRunsWss],
    ['/ws/workflows', workflowsWss],
    ['/ws/workflow-runs', workflowRunsWss],
    ['/ws/health', healthWss],
    ['/ws/harnesses', harnessesWss],
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
