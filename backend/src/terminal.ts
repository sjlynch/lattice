import os from 'node:os';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows
  ? process.env.COMSPEC || 'powershell.exe'
  : process.env.SHELL || 'bash';

export type TerminalOptions = {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
};

export function attachTerminal(ws: WebSocket, opts: TerminalOptions = {}) {
  const shell = opts.shell || defaultShell;
  const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : os.homedir();

  let term: pty.IPty;
  try {
    term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd,
      env: process.env as { [key: string]: string },
    });
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Failed to spawn shell ${shell}: ${(err as Error).message}`,
      }),
    );
    ws.close();
    return;
  }

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  term.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode }));
      ws.close();
    }
  });

  ws.on('message', (raw) => {
    let msg: { type: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      term.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      try {
        term.resize(msg.cols, msg.rows);
      } catch {
        // ignore
      }
    }
  });

  ws.on('close', () => {
    try {
      term.kill();
    } catch {
      // ignore
    }
  });
}
