// All WebSocket endpoints share one HTTP server. Using `{ server, path }`
// per WSS is broken: each WSS adds its own `upgrade` listener and the
// first to see a non-matching path aborts the handshake before the
// matching one runs. Solution: noServer mode + a single dispatcher that
// routes by pathname.

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import { buildHarnessesWss } from './endpoints/harnesses.js';
import { buildHealthWss } from './endpoints/health.js';
import { buildMergeRunsWss } from './endpoints/mergeRuns.js';
import { buildTasksWss } from './endpoints/tasks.js';
import { buildTerminalWss } from './endpoints/terminal.js';
import { buildWorkflowRunsWss } from './endpoints/workflowRuns.js';
import { buildWorkflowsWss } from './endpoints/workflows.js';

type WebSocketRoute = readonly [path: string, wss: WebSocketServer];

function buildWebSocketRoutes(): WebSocketRoute[] {
  return [
    ['/ws/terminal', buildTerminalWss()],
    ['/ws/tasks', buildTasksWss()],
    ['/ws/merge-runs', buildMergeRunsWss()],
    ['/ws/workflows', buildWorkflowsWss()],
    ['/ws/workflow-runs', buildWorkflowRunsWss()],
    ['/ws/health', buildHealthWss()],
    ['/ws/harnesses', buildHarnessesWss()],
  ];
}

export function attachWebSockets(server: http.Server): void {
  const routes = buildWebSocketRoutes();

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
