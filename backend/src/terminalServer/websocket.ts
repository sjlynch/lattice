import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { attachTerminal } from '../terminal.js';
import { isPtyDimension } from '../terminal/attach.js';
import { isAllowedOrigin } from '../wsOriginAllowlist.js';
import { createTerminalAdmission, type TerminalAdmission } from './admission.js';

// A query dimension that isn't a positive integer (absent, `NaN`, `0`, `80.5`,
// `-1`) falls back to the default rather than reaching node-pty.
function dimensionParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  const n = raw === null ? NaN : Number(raw);
  return isPtyDimension(n) ? n : fallback;
}

export function createTerminalWebSocketServer(admission: TerminalAdmission = createTerminalAdmission()): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const id = url.searchParams.get('id') || undefined;
    const cwd = url.searchParams.get('cwd') || undefined;
    const cols = dimensionParam(url, 'cols', 80);
    const rows = dimensionParam(url, 'rows', 24);
    const initialCommand = url.searchParams.get('initialCommand') || undefined;
    const projectPath = url.searchParams.get('projectPath') || undefined;
    const release = id ? () => {} : admission.begin();
    if (!release) {
      ws.send(JSON.stringify({ type: 'error', message: 'Terminal server is upgrading; reopen this terminal shortly.' }));
      ws.close();
      return;
    }
    try { attachTerminal(ws, { id, cwd, cols, rows, initialCommand, projectPath }); }
    finally { release(); }
  });
  return wss;
}

export function attachTerminalWebSocketUpgrade(
  server: Server,
  wss: WebSocketServer,
): void {
  server.on('upgrade', (req, socket, head) => {
    // CSWSH defence. This detached server owns the pty and runs `initialCommand`
    // on a fresh session, so a drive-by page reaching it is arbitrary command
    // execution. WS handshakes aren't bound by same-origin policy, so a browser-
    // supplied Origin outside the allowlist is rejected here, before the upgrade
    // — mirroring the main server's gate. Absent-Origin clients (the node relay,
    // curl) are allowed so legitimate terminals keep working. See
    // `../wsOriginAllowlist.ts`.
    if (!isAllowedOrigin(req.headers.origin)) {
      socket.destroy();
      return;
    }
    if (new URL(req.url || '', 'http://localhost').pathname === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
}
