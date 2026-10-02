import type { IDisposable, Terminal } from '@xterm/xterm';

// xterm answers terminal queries through onData, the same event as keystrokes.
// Replaying a startup query into an already running TUI therefore inserts its
// late reply into the prompt. Consume queries only while parsing history, while
// still replaying text, colors, cursor movement and terminal modes normally.
export function createTerminalOutput(term: Terminal) {
  let expectingReplay = false;
  let replaying = false;
  let writing = false;
  let disposed = false;
  const pending: { data: string; replayed: boolean }[] = [];
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

  const pump = () => {
    if (disposed || writing) return;
    const next = pending.shift();
    if (!next) return;
    writing = true;
    replaying = next.replayed;
    // write is asynchronous. Keep history's query guard through the parser's
    // completion callback, and queue live writes until that callback fires.
    term.write(next.data, () => {
      writing = false;
      replaying = false;
      pump();
    });
  };

  return {
    beginReplay() { expectingReplay = true; },
    write(data: string, replayed?: boolean) {
      if (disposed) return;
      // Retained older executors don't label data frames: their first data
      // after attached is the scrollback window (including the Lattice banner).
      pending.push({ data, replayed: replayed ?? expectingReplay });
      expectingReplay = false;
      pump();
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      for (const handler of handlers) handler.dispose();
    },
  };
}
