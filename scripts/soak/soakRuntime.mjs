import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Handles and generations belong to this invocation, never to module globals.
export function createSoakRuntime({ root, home, repoRoot, distEntry, env, origin: ORIGIN, terminalPort: TERMINAL_PORT }) {
  let backend = null;
  let backendGen = 0;

  function startBackend() {
    const gen = ++backendGen;
    const out = fs.openSync(path.join(root, `backend-${gen}.log`), 'a');
    backend = spawn(process.execPath, [distEntry], {
      cwd: path.join(repoRoot, 'backend'),
      env,
      stdio: ['ignore', out, out],
    });
    backend.gen = gen;
    return backend;
  }

  async function killBackend() {
    const b = backend;
    if (!b || b.exitCode !== null) return;
    const exited = new Promise((r) => b.once('exit', r));
    b.kill('SIGKILL');
    await exited;
  }

  async function api(method, p, body, { retryMs = 60_000 } = {}) {
    const deadline = Date.now() + retryMs;
    for (;;) {
      try {
        const res = await fetch(`${ORIGIN}${p}`, {
          method,
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 503 || res.status === 502) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = text;
        }
        return { status: res.status, json };
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await sleep(500);
      }
    }
  }

  async function waitHealthy() {
    await api('GET', '/api/health', undefined, { retryMs: 120_000 });
  }

  async function shutdownTerminalServer() {
    try {
      const token = fs.readFileSync(path.join(home, '.lattice', 'terminalServerToken'), 'utf8').trim();
      await fetch(`http://127.0.0.1:${TERMINAL_PORT}/shutdown`, {
        method: 'POST',
        headers: { 'x-lattice-terminal-token': token },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // already gone
    }
  }

  return { startBackend, killBackend, api, waitHealthy, shutdownTerminalServer };
}
