// All WebSocket endpoints share one HTTP server. Using `{ server, path }`
// per WSS is broken: each WSS adds its own `upgrade` listener and the
// first to see a non-matching path aborts the handshake before the
// matching one runs. Solution: noServer mode + a single dispatcher that
// routes by pathname.

import type http from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocketServer } from 'ws';
import { isAllowedOrigin } from '../wsOriginAllowlist.js';
import { buildAgentSessionsWss } from './endpoints/agentSessions.js';
import { buildGitBranchWss } from './endpoints/gitBranch.js';
import { buildGitStatusWss } from './endpoints/gitStatus.js';
import { buildHarnessesWss } from './endpoints/harnesses.js';
import { buildHealthWss } from './endpoints/health.js';
import { buildMergeRunsWss } from './endpoints/mergeRuns.js';
import { buildPostMergeHooksWss } from './endpoints/postMergeHooks.js';
import { buildTasksWss } from './endpoints/tasks.js';
import { buildTerminalWss } from './endpoints/terminal.js';
import { buildTerminalActivityWss } from './endpoints/terminalActivity.js';
import { buildTerminalTabsWss } from './endpoints/terminalTabs.js';
import { buildWorkflowRunsWss } from './endpoints/workflowRuns.js';
import { buildWorkflowsWss } from './endpoints/workflows.js';

type WebSocketRoute = readonly [path: string, wss: WebSocketServer];

// CSWSH origin allowlist is shared with the detached terminal-server (:5185)
// via `../wsOriginAllowlist.ts` so the two can't drift — see that module.

function buildWebSocketRoutes(): WebSocketRoute[] {
  return [
    ['/ws/terminal', buildTerminalWss()],
    ['/ws/terminal-activity', buildTerminalActivityWss()],
    ['/ws/terminal-tabs', buildTerminalTabsWss()],
    ['/ws/tasks', buildTasksWss()],
    ['/ws/agent-sessions', buildAgentSessionsWss()],
    ['/ws/merge-runs', buildMergeRunsWss()],
    ['/ws/post-merge-hooks', buildPostMergeHooksWss()],
    ['/ws/workflows', buildWorkflowsWss()],
    ['/ws/workflow-runs', buildWorkflowRunsWss()],
    ['/ws/health', buildHealthWss()],
    ['/ws/git-branch', buildGitBranchWss()],
    ['/ws/git-status', buildGitStatusWss()],
    ['/ws/harnesses', buildHarnessesWss()],
  ];
}

// The route key for an upgrade request, or null for a URL `new URL` rejects.
export function upgradePathname(reqUrl: string | undefined): string | null {
  try {
    return new URL(reqUrl || '', 'http://localhost').pathname;
  } catch {
    return null;
  }
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
      // An absolute-form request target (`GET http://[ HTTP/1.1`) passes
      // Node's HTTP parser but makes `new URL` throw — inside an `upgrade`
      // listener that is an uncaughtException, i.e. the whole backend exits.
      const pathname = upgradePathname(req.url);
      const match = pathname === null ? undefined : routes.find(([p]) => p === pathname);
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
