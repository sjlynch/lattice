import type { IDisposable, Terminal } from '@xterm/xterm';

// Most unparsed output one pane may queue, in chars — in line with the
// backend's 8 MB slow-client cut-off (backend/src/terminal/broadcast.ts). The
// queue below hands xterm one chunk at a time, so xterm's own 50 MB
// WriteBuffer discard never triggers; and a hidden browser tab throttles
// xterm's parse timers to once a second (once a minute later) while
// ws.onmessage keeps firing at full rate. Unbounded, a busy agent pane piled
// hundreds of MB of live strings here and crashed the tab "Out of Memory".
export const MAX_PENDING_OUTPUT_CHARS = 8 * 1024 * 1024;

type OutputStep = { data: string; replayed: boolean } | 'clear';

// xterm answers terminal queries through onData, the same event as keystrokes.
// Replaying a startup query into an already running TUI therefore inserts its
// late reply into the prompt. Consume queries only while parsing history, while
// still replaying text, colors, cursor movement and terminal modes normally.
//
// `onOverflow` fires when the queue passes MAX_PENDING_OUTPUT_CHARS and has
// been dropped; the owner recovers the pane (a reattach clears and replays it).
export function createTerminalOutput(term: Terminal, onOverflow?: () => void) {
  let expectingReplay = false;
  let replaying = false;
  let writing = false;
  let disposed = false;
  const pending: OutputStep[] = [];
  let pendingChars = 0;
  const handlers: IDisposable[] = [
    term.parser.registerCsiHandler({ final: 'c' }, () => replaying),
    term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => replaying),
    term.parser.registerCsiHandler({ final: 'n' }, () => replaying),
    term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, () => replaying),
    term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, () => replaying),
    term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, () => replaying),
    term.parser.registerCsiHandler({ final: 't' }, (params) => replaying && [14, 16, 18, 20, 21].includes(params[0] as number)),
    term.parser.registerEscHandler({ final: 'Z' }, () => replaying),
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => replaying),
    ...[4, 10, 11, 12].map((id) => term.parser.registerOscHandler(id, (data) => replaying && data.split(';').includes('?'))),
  ];

  const drop = () => {
    pending.length = 0;
    pendingChars = 0;
  };

  const pump = () => {
    while (!disposed && !writing) {
      const next = pending.shift();
      if (!next) return;
      // A reattach's clear runs as a queue step, after the chunk xterm was
      // already parsing, so none of that stale output lands above the replay.
      if (next === 'clear') {
        term.clear();
        continue;
      }
      pendingChars -= next.data.length;
      writing = true;
      replaying = next.replayed;
      // write is asynchronous. Keep history's query guard through the parser's
      // completion callback, and queue live writes until that callback fires.
      term.write(next.data, () => {
        writing = false;
        replaying = false;
        pump();
      });
    }
  };

  return {
    // An `attached` frame: everything still queued is stale (the replay that
    // follows already contains it), so drop it and clear the pane in order.
    beginReplay() {
      if (disposed) return;
      drop();
      pending.push('clear');
      expectingReplay = true;
      pump();
    },
    write(data: string, replayed?: boolean) {
      if (disposed) return;
      // Retained older executors don't label data frames: their first data
      // after attached is the scrollback window (including the Lattice banner).
      pending.push({ data, replayed: replayed ?? expectingReplay });
      pendingChars += data.length;
      expectingReplay = false;
      pump();
      // Only output stuck behind the chunk xterm is still parsing counts: a
      // pane that keeps up hands every chunk straight over.
      if (pendingChars > MAX_PENDING_OUTPUT_CHARS) {
        drop();
        onOverflow?.();
      }
    },
    dispose() {
      disposed = true;
      drop();
      for (const handler of handlers) handler.dispose();
    },
  };
}
