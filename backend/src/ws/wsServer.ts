// All WebSocket endpoints share one HTTP server. Using `{ server, path }`
// per WSS is broken: each WSS adds its own `upgrade` listener and the
// first to see a non-matching path aborts the handshake before the
// matching one runs. Solution: noServer mode + a single dispatcher that
// routes by pathname.

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import { buildAgentSessionsWss } from './endpoints/agentSessions.js';
import { buildHarnessesWss } from './endpoints/harnesses.js';
import { buildHealthWss } from './endpoints/health.js';
import { buildMergeRunsWss } from './endpoints/mergeRuns.js';
import { buildPostMergeHooksWss } from './endpoints/postMergeHooks.js';
import { buildTasksWss } from './endpoints/tasks.js';
import { buildTerminalWss } from './endpoints/terminal.js';
import { buildWorkflowRunsWss } from './endpoints/workflowRuns.js';
import { buildWorkflowsWss } from './endpoints/workflows.js';

type WebSocketRoute = readonly [path: string, wss: WebSocketServer];

// Cross-Site WebSocket Hijacking defence. Browsers always send an immutable
// `Origin` header on a WS handshake and cannot forge it from a cross-site
// page, so rejecting any browser-supplied Origin outside this allowlist fully
// closes the drive-by-RCE hole (a malicious page can't open /ws/terminal and
// run an `initialCommand`). Non-browser clients (the node terminal relay,
// curl) send NO Origin header — those are allowed through, since they are not
// the CSWSH threat and the server is loopback-bound anyway. Both the
// `localhost` and `127.0.0.1` forms are listed because the user may load the
// app from either; dropping one breaks terminals + all live WS updates.
const ALLOWED_WS_ORIGINS: ReadonlySet<string> = new Set([
  'http://localhost:5183',
  'http://127.0.0.1:5183',
]);

function isAllowedOrigin(origin: string | undefined): boolean {
  // Absent Origin = non-browser client (relay/curl), not the CSWSH threat.
  if (origin === undefined) return true;
  return ALLOWED_WS_ORIGINS.has(origin);
}

function buildWebSocketRoutes(): WebSocketRoute[] {
  return [
    ['/ws/terminal', buildTerminalWss()],
    ['/ws/tasks', buildTasksWss()],
    ['/ws/agent-sessions', buildAgentSessionsWss()],
    ['/ws/merge-runs', buildMergeRunsWss()],
    ['/ws/post-merge-hooks', buildPostMergeHooksWss()],
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
      // Reject cross-site handshakes before routing (applies to every route).
      if (!isAllowedOrigin(req.headers.origin)) {
        socket.destroy();
        return;
      }
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
