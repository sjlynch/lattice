// Fleet terminal control: read a pty's screen, type into it, wait for it to go
// quiet — for the Fleet view and the MCP fleet tools, across every project.
//
// Each call is one short-lived client of the executor's own attach socket
// (`/ws/terminal?id=` on the detached terminal-server — the same protocol the
// browser relay speaks), so it works against the executor already running:
// adding routes to the executor would change its fingerprint and wait for
// every pty to close before taking effect. Attaching never resizes the pty and
// detaching never kills it. Output is rendered through a headless xterm, so an
// agent TUI's cursor-addressed redraws read back as the screen a human sees.

import xtermHeadless from '@xterm/headless';
import { WebSocket } from 'ws';

import { TERMINAL_PORT } from '../terminalServerLifecycle.js';
import { noteTerminalClientInput } from '../terminalActivity.js';
import { noteTerminalPromptSubmit } from '../callbackOutbox/replayGuard.js';
import type { TerminalScreen } from './types.js';

const { Terminal } = xtermHeadless;

const ATTACH_TIMEOUT_MS = 8_000;
// Rendered scrollback kept while reading a screen (lines beyond the viewport).
const SCROLLBACK_LINES = 2_000;
// Bracketed-paste delimiters: multi-line text into an agent TUI arrives as one
// paste instead of a line-by-line submit.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export class TerminalControlError extends Error {
  constructor(message: string, readonly code: 'not-found' | 'unreachable' | 'timeout') {
    super(message);
  }
}

type Attachment = {
  ws: WebSocket;
  cols: number;
  rows: number;
  // Resolves with the replayed scrollback (the frame the executor sends right
  // after `attached`).
  replay: Promise<string>;
  // Live output after the replay.
  onLive: (fn: (data: string) => void) => void;
  close: () => void;
};

// One attach to pty `id`. Rejects `not-found` when the executor answers with
// an error frame / closes before `attached`, `unreachable` when it can't be
// reached, `timeout` after 8 s.
export function attachTerminal(id: string, port = TERMINAL_PORT): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?id=${encodeURIComponent(id)}`);
    let attached = false;
    let replayed = false;
    let resolveReplay: (s: string) => void = () => {};
    const replay = new Promise<string>((r) => { resolveReplay = r; });
    const live: Array<(d: string) => void> = [];
    const timer = setTimeout(() => {
      if (!attached) { ws.terminate(); reject(new TerminalControlError('terminal did not attach in time', 'timeout')); }
    }, ATTACH_TIMEOUT_MS);
    ws.on('error', (err) => {
      clearTimeout(timer);
      if (!attached) reject(new TerminalControlError(`terminal server unreachable: ${err.message}`, 'unreachable'));
    });
    ws.on('close', () => {
      clearTimeout(timer);
      if (!attached) reject(new TerminalControlError(`no live terminal ${id}`, 'not-found'));
      resolveReplay('');
    });
    ws.on('message', (raw) => {
      let msg: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown; replayed?: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'attached' && !attached) {
        attached = true;
        clearTimeout(timer);
        resolve({
          ws,
          cols: typeof msg.cols === 'number' ? msg.cols : 120,
          rows: typeof msg.rows === 'number' ? msg.rows : 30,
          replay,
          onLive: (fn) => { live.push(fn); },
          close: () => { try { ws.close(); } catch { /* gone */ } },
        });
      } else if (msg.type === 'data' && typeof msg.data === 'string') {
        if (!replayed && msg.replayed === true) { replayed = true; resolveReplay(msg.data); }
        else for (const fn of live) fn(msg.data);
      } else if (msg.type === 'error' && !attached) {
        clearTimeout(timer);
        ws.terminate();
        reject(new TerminalControlError(`no live terminal ${id}`, 'not-found'));
      }
    });
  });
}

// Raw pty output → rendered text: the visible screen and the last `lines`
// lines (scrollback + screen), trailing blank lines trimmed.
export function renderTerminalText(data: string, cols: number, rows: number, lines = 200): Promise<{ screen: string; tail: string }> {
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  return new Promise((resolve) => {
    term.write(data, () => {
      const buf = term.buffer.active;
      const all: string[] = [];
      for (let i = 0; i < buf.length; i++) all.push(buf.getLine(i)?.translateToString(true) ?? '');
      const trim = (xs: string[]) => {
        let end = xs.length;
        while (end > 0 && !xs[end - 1].trim()) end--;
        return xs.slice(0, end).join('\n');
      };
      const screenStart = buf.baseY;
      resolve({ screen: trim(all.slice(screenStart, screenStart + rows)), tail: trim(all.slice(Math.max(0, all.length - Math.max(1, lines)))) });
      term.dispose();
    });
  });
}

export async function readTerminalScreen(id: string, opts: { lines?: number; port?: number } = {}): Promise<TerminalScreen> {
  const a = await attachTerminal(id, opts.port);
  try {
    const data = await a.replay;
    const { screen, tail } = await renderTerminalText(data, a.cols, a.rows, Math.min(Math.max(opts.lines ?? 200, 1), SCROLLBACK_LINES));
    return { id, cols: a.cols, rows: a.rows, screen, tail };
  } finally {
    a.close();
  }
}

// Type `text` into pty `id`. Multi-line text goes as one bracketed paste
// (`paste` defaults to "text has a newline"); `submit` presses Enter after a
// short pause, as its own keystroke, so a TUI that treats a pasted newline as
// literal still submits. Stamped like browser input, so the activity signal
// and the callback replay guard see the turn it starts.
export async function sendTerminalInput(id: string, text: string, opts: { submit?: boolean; paste?: boolean; port?: number } = {}): Promise<void> {
  const a = await attachTerminal(id, opts.port);
  try {
    await a.replay;
    const paste = opts.paste ?? text.includes('\n');
    const send = (data: string) => new Promise<void>((resolve, reject) => a.ws.send(JSON.stringify({ type: 'input', data }), (err) => (err ? reject(err) : resolve())));
    noteTerminalClientInput(id);
    if (text) await send(paste ? `${PASTE_START}${text}${PASTE_END}` : text);
    if (opts.submit) {
      await new Promise((r) => setTimeout(r, 150));
      await send('\r');
      noteTerminalPromptSubmit(id);
    }
    // Let the frames flush before the socket closes.
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    a.close();
  }
}

// Wait until pty `id` has printed nothing for `quietMs` (agent TUIs animate a
// spinner or timer while they work, so silence means idle), or `timeoutMs`.
export async function waitTerminalQuiet(id: string, opts: { quietMs?: number; timeoutMs?: number; port?: number } = {}): Promise<{ idle: boolean; waitedMs: number }> {
  const quietMs = Math.min(Math.max(opts.quietMs ?? 4_000, 500), 60_000);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 50_000, 1_000), 600_000);
  const t0 = Date.now();
  const a = await attachTerminal(id, opts.port);
  try {
    await a.replay;
    let last = Date.now();
    a.onLive(() => { last = Date.now(); });
    let closed = false;
    a.ws.on('close', () => { closed = true; });
    for (;;) {
      if (closed) return { idle: true, waitedMs: Date.now() - t0 };
      const now = Date.now();
      if (now - last >= quietMs) return { idle: true, waitedMs: now - t0 };
      if (now - t0 >= timeoutMs) return { idle: false, waitedMs: now - t0 };
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    a.close();
  }
}
