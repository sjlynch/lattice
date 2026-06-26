import { WebSocketServer } from 'ws';
import {
  ensureTerminalServer,
  proxyTerminalWs,
} from '../../terminalProxy.js';

export function buildTerminalWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    // Attach the client 'error' listener BEFORE the await below: without it, a
    // socket error (ECONNRESET/EPIPE from an abrupt disconnect) that fires while
    // `ensureTerminalServer()` is in flight re-throws as a process-level
    // uncaughtException in ws v8. `proxyTerminalWs` adds its own teardown
    // 'error' handler once it runs; a second listener is harmless.
    ws.on('error', () => { /* routine client disconnect — ignore */ });
    // Self-heal: restart the terminal server if it crashed while main was running.
    await ensureTerminalServer().catch(() => {});
    proxyTerminalWs(ws, req.url ?? undefined);
  });
  return wss;
}
