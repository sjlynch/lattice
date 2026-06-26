import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { attachTerminal } from '../terminal.js';
import { isAllowedOrigin } from '../wsOriginAllowlist.js';

export function createTerminalWebSocketServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', 'http://localhost');
    const id = url.searchParams.get('id') || undefined;
    const cwd = url.searchParams.get('cwd') || undefined;
    const cols = Number(url.searchParams.get('cols')) || 80;
    const rows = Number(url.searchParams.get('rows')) || 24;
    const initialCommand = url.searchParams.get('initialCommand') || undefined;
    const projectPath = url.searchParams.get('projectPath') || undefined;
    attachTerminal(ws, { id, cwd, cols, rows, initialCommand, projectPath });
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
