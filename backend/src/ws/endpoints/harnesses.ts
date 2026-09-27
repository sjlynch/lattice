import { WebSocketServer } from 'ws';
import { detectHarnesses, onHarnessAvailabilityChange } from '../../harnessDetect.js';
import { sendJson } from '../projectEndpoint.js';

// Push harness availability once detection completes. Lets the UI render
// the Pi/Codex/Interleave options as soon as the backend knows, even when
// the frontend was loaded before the server finished booting — the WS
// auto-reconnects, so the eventual `detectHarnesses()` resolution reaches
// the client without a manual refresh. A later corrected snapshot (a boot
// probe that timed out, fixed by the background re-probe) is pushed too.
export function buildHarnessesWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    // Without an 'error' listener, ws v8 re-throws an underlying socket error
    // (ECONNRESET/EPIPE from an abrupt disconnect) as a process uncaughtException.
    // A dropped client is routine here — log-and-ignore.
    ws.on('error', () => { /* routine client disconnect — ignore */ });
    const unsubscribe = onHarnessAvailabilityChange((avail) => {
      sendJson(ws, avail);
    });
    ws.on('close', unsubscribe);
    detectHarnesses()
      .then((avail) => {
        sendJson(ws, avail);
      })
      .catch(() => { /* leave client on its default */ });
  });
  return wss;
}
