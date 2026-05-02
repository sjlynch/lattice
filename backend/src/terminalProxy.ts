// Manages the lifecycle of the terminal server (a separate process on port
// 5185) and proxies terminal WebSocket connections to it.
//
// Design rationale: PTY sessions are owned by terminal-server.ts, which runs
// detached from the main server. When the main server restarts (e.g. during
// development), the terminal server keeps running and all Claude agents inside
// it continue uninterrupted. The main server reconnects on next startup.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;
const BASE = `http://127.0.0.1:${TERMINAL_PORT}`;

async function isAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Singleton: concurrent callers share one startup attempt instead of each
// spawning a separate process that fights for port 5185.
let starting: Promise<void> | null = null;

async function spawnAndWait(): Promise<void> {
  const script = path.join(__dirname, 'terminal-server.js');
  const child = spawn(process.execPath, [script], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, TERMINAL_PORT: String(TERMINAL_PORT) },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, 100));
    if (await isAlive()) {
      console.log(
        `[lattice-backend] terminal server started on port ${TERMINAL_PORT}`,
      );
      return;
    }
  }
  console.error(
    '[lattice-backend] terminal server did not start in 5 s — terminals unavailable',
  );
}

// Ensures the terminal server is running. No-ops if already alive.
// Concurrent callers share a single startup attempt.
export async function ensureTerminalServer(): Promise<void> {
  if (await isAlive()) return;
  if (!starting) {
    starting = spawnAndWait().finally(() => {
      starting = null;
    });
  }
  return starting;
}

// Proxies a terminal WebSocket from the UI through to the terminal server.
// Bidirectional relay; either side closing tears down both ends.
export function proxyTerminalWs(
  clientWs: WebSocket,
  reqUrl: string | undefined,
) {
  const params = new URL(reqUrl ?? '', 'http://localhost').searchParams;
  const targetWs = new WebSocket(
    `ws://127.0.0.1:${TERMINAL_PORT}/ws/terminal?${params.toString()}`,
  );

  // Buffer messages that arrive before the upstream connection is open.
  const pending: Array<{ data: RawData; isBinary: boolean }> = [];

  clientWs.on('message', (data: RawData, isBinary: boolean) => {
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.send(data, { binary: isBinary });
    } else {
      pending.push({ data, isBinary });
    }
  });

  targetWs.on('open', () => {
    for (const { data, isBinary } of pending) {
      try {
        targetWs.send(data, { binary: isBinary });
      } catch {
        /* upstream dropped between open and flush — discard */
      }
    }
    pending.length = 0;
  });

  targetWs.on('message', (data: RawData, isBinary: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  targetWs.on('error', (err) => {
    console.error('[terminal-proxy] upstream error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  targetWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
  });

  clientWs.on('close', () => {
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });

  clientWs.on('error', () => {
    const s = targetWs.readyState;
    if (s !== WebSocket.CLOSED && s !== WebSocket.CLOSING) targetWs.close();
  });
}

export async function proxyListSessions(): Promise<unknown[]> {
  try {
    const res = await fetch(`${BASE}/sessions`);
    return res.ok ? ((await res.json()) as unknown[]) : [];
  } catch {
    return [];
  }
}

// Kill all terminal sessions whose cwd is inside `worktreePath`.
// Call before deleting a worktree directory so Windows releases file locks.
export async function proxyKillSessionsByCwd(worktreePath: string): Promise<void> {
  try {
    await fetch(
      `${BASE}/sessions/by-cwd?cwd=${encodeURIComponent(worktreePath)}`,
      { method: 'DELETE' },
    );
  } catch {
    /* terminal server down or no matching sessions — safe to ignore */
  }
}

export async function proxyKillSession(id: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BASE}/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return res.ok;
  } catch {
    return false;
  }
}
