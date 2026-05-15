import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { attachTerminal } from '../terminal.js';

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
    if (new URL(req.url || '', 'http://localhost').pathname === '/ws/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
}
