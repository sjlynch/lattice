import { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import {
  ensureTerminalServer,
  proxyTerminalWs,
} from '../../terminalProxy.js';
import type { EarlyFrame } from '../../terminalWsRelay.js';

export function buildTerminalWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', async (ws, req) => {
    // Attach the client 'error' listener BEFORE the await below: without it, a
    // socket error (ECONNRESET/EPIPE from an abrupt disconnect) that fires while
    // `ensureTerminalServer()` is in flight re-throws as a process-level
    // uncaughtException in ws v8. `proxyTerminalWs` adds its own teardown
    // 'error' handler once it runs; a second listener is harmless.
    ws.on('error', () => { /* routine client disconnect — ignore */ });
    // Likewise buffer client frames: anything typed while the await below is
    // in flight has no relay to go to yet and would simply vanish.
    const early: EarlyFrame[] = [];
    const capture = (data: RawData, isBinary: boolean) => { early.push({ data, isBinary }); };
    ws.on('message', capture);
    // Self-heal: restart the terminal server if it crashed while main was running.
    const info = await ensureTerminalServer().catch(() => null);
    ws.off('message', capture);
    proxyTerminalWs(ws, req.url ?? undefined, {
      // An executor that records titles natively spares the relay its
      // per-frame title parse (see terminalActivityRelay.ts).
      nativeTerminalTitle: info?.capabilities?.nativeTerminalTitle === true,
      earlyFrames: early,
    });
  });
  return wss;
}
