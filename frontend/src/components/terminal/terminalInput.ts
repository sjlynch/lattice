import type { IDisposable, Terminal } from '@xterm/xterm';

// How long the terminal's size must hold still before the pty hears about it.
// A sidebar drag refits the pane on every pointer move, and each pty resize is
// a SIGWINCH to the harness: Codex (since its resize-reflow landed) clears its
// scrollback and re-emits up to thousands of transcript rows on every width
// change, so forwarding each intermediate size turned one drag into minutes of
// redraw on a busy machine. Only the settled size is worth sending; xterm
// itself is already laid out at the new size in the meantime.
export const RESIZE_DEBOUNCE_MS = 150;

// Forward typed input and resize events to the live socket. `getSocket` is read
// lazily on every event because the hook reassigns its `ws` across reconnects.
export function forwardTerminalInput(
  term: Terminal,
  getSocket: () => WebSocket | null,
  schedule: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  } = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as number) },
): IDisposable {
  const send = (payload: object) => {
    const ws = getSocket();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };
  const dataDisposable = term.onData((data) => send({ type: 'input', data }));
  let pendingResize: { cols: number; rows: number } | null = null;
  let resizeTimer: unknown = null;
  const flushResize = () => {
    resizeTimer = null;
    const size = pendingResize;
    pendingResize = null;
    if (size) send({ type: 'resize', cols: size.cols, rows: size.rows });
  };
  const resizeDisposable = term.onResize(({ cols, rows }) => {
    pendingResize = { cols, rows };
    if (resizeTimer !== null) schedule.clearTimeout(resizeTimer);
    resizeTimer = schedule.setTimeout(flushResize, RESIZE_DEBOUNCE_MS);
  });
  return {
    dispose() {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      if (resizeTimer !== null) schedule.clearTimeout(resizeTimer);
      resizeTimer = null;
      pendingResize = null;
    },
  };
}
