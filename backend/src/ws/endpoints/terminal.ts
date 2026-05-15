import { WebSocketServer } from 'ws';
import {
  ensureTerminalServer,
  proxyTerminalWs,
} from '../../terminalProxy.js';

export function buildTerminalWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    // Self-heal: restart the terminal server if it crashed while main was running.
    await ensureTerminalServer().catch(() => {});
    proxyTerminalWs(ws, req.url ?? undefined);
  });
  return wss;
}
