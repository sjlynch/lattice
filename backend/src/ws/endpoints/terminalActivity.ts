import { WebSocketServer } from 'ws';
import { subscribeTerminalActivity } from '../../terminalActivity.js';
import { buildProjectWss } from '../projectEndpoint.js';

// Pushes the set of terminal sessions whose harness is still emitting output —
// the sidebar turns each into a tiny spinner in place of that tab's icon. Sent
// once on connect and again on every change (never per poll tick), so an idle
// board costs nothing on the wire.
//
// `?project=` scopes the CONNECTION like every other endpoint here, but the
// payload is machine-wide on purpose: ids are opaque and the sidebar already
// only knows about its own project's tabs. See `terminalActivity.ts`.
export function buildTerminalActivityWss(): WebSocketServer {
  return buildProjectWss<{ busy: string[] }>({
    subscribe: (listener) =>
      subscribeTerminalActivity((busy) => listener({ busy })),
    payloadFromEvent: (event) => ({
      type: 'terminal-activity',
      busy: event.busy,
    }),
  });
}
