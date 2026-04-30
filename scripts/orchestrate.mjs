#!/usr/bin/env node
//
// Lattice dev orchestrator.
//
// Boots backend first, waits until `/api/health` responds 200, then boots
// frontend. This eliminates the cold-start race window where vite is
// already serving the SPA but the backend hasn't finished compiling +
// listening yet — which used to surface as a flood of `ECONNREFUSED`
// proxy errors plus a stuck "Scanning…" overlay.
//
// Replaces concurrently for `npm run dev`. Output is line-prefixed
// [backend] / [frontend] in matching colors so the console looks similar.
// Mid-session backend restarts (tsc-w → emit → node --watch restart) are
// handled by the existing client-side retry/reconnect logic.

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const HEALTH_URL = 'http://127.0.0.1:5184/api/health';
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 200;

const COLORS = {
  backend: '\x1b[36m', // cyan
  frontend: '\x1b[35m', // magenta
  lattice: '\x1b[33m', // yellow
  reset: '\x1b[0m',
};

function note(msg) {
  process.stdout.write(`${COLORS.lattice}[lattice]${COLORS.reset} ${msg}\n`);
}

// vite's proxy middleware logs each proxy error as a multi-line block:
//
//   [vite] ws proxy error:
//   Error: connect ECONNREFUSED 127.0.0.1:5184
//       at TCPConnectWrap.afterConnect (...)
//       ... more stack ...
//
// or with an error-object dump:
//
//   [vite] http proxy error: /api/scan
//   Error: connect ECONNREFUSED 127.0.0.1:5184
//       at ...  {
//     errno: -4078,
//     code: 'ECONNREFUSED',
//     ...
//   }
//
// vite's customLogger doesn't catch these (they take a different code
// path), so we filter at the pipe level. State machine: trigger line
// switches to "suppress mode"; we stay in suppress mode while lines
// look like a continuation (Error: …, stack frames, object props,
// braces, blanks). Any other line exits suppress and is emitted.
const ANSI = /\x1b\[[0-9;]*m/g;
const VITE_PROXY_TRIGGER = /\[vite\]\s+(ws|http) proxy (?:socket )?error/i;
const STACK_LINE = /^\s+at\s/;
const ERROR_HEADER = /^Error[:]/;
const ERROR_PROP = /^\s+(errno|code|syscall|address|port|hostname|info|message)[:]/;
const OPEN_BRACE = /^\s*\{\s*$/;
const CLOSE_BRACE = /^\s*\}\s*$/;

function isContinuation(plain) {
  if (plain.trim() === '') return true;
  if (ERROR_HEADER.test(plain)) return true;
  if (STACK_LINE.test(plain)) return true;
  if (ERROR_PROP.test(plain)) return true;
  if (OPEN_BRACE.test(plain)) return true;
  if (CLOSE_BRACE.test(plain)) return true;
  return false;
}

function startChild(label, color, args, { filterViteProxy = false } = {}) {
  const child = spawn(npmCmd, args, {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
  });

  function prefixLines(stream, sink) {
    let buffer = '';
    let suppressing = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (filterViteProxy) {
          const plain = line.replace(ANSI, '');
          // Trigger always opens (or extends) a suppressed block — even
          // when we were already suppressing the previous one. Without
          // this, two back-to-back proxy errors would have the second
          // trigger line treated as the "exit" of the first block.
          if (VITE_PROXY_TRIGGER.test(plain)) {
            suppressing = true;
            continue;
          }
          if (suppressing) {
            if (isContinuation(plain)) continue;
            suppressing = false;
            // fall through and emit this line
          }
        }
        sink.write(`${color}[${label}]${COLORS.reset} ${line}\n`);
      }
    });
    stream.on('end', () => {
      if (buffer)
        sink.write(`${color}[${label}]${COLORS.reset} ${buffer}\n`);
    });
  }
  prefixLines(child.stdout, process.stdout);
  prefixLines(child.stderr, process.stderr);

  return child;
}

function killTree(child, signal = 'SIGTERM') {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // npm.cmd spawns node as a child; SIGTERM on the .cmd doesn't kill
    // the descendants. taskkill /T walks the tree.
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      /* ignore */
    }
  } else {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

function probeHealth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const ok = res.statusCode === 200;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(url)) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

note('starting backend...');
const backend = startChild('backend', COLORS.backend, [
  '--prefix',
  'backend',
  'run',
  'dev',
]);

let shuttingDown = false;
let frontend = null;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(backend, signal);
  if (frontend) killTree(frontend, signal);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}

backend.on('exit', (code) => {
  if (!shuttingDown) {
    note(`backend exited (code ${code ?? 0}) — stopping frontend.`);
  }
  shutdown('SIGTERM');
  process.exit(code ?? 0);
});

const ready = await waitForHealth(HEALTH_URL, HEALTH_TIMEOUT_MS);
if (!ready) {
  note(
    `backend did not respond on ${HEALTH_URL} within ${HEALTH_TIMEOUT_MS / 1000}s — starting frontend anyway.`,
  );
} else {
  note('backend healthy. starting frontend...');
}

frontend = startChild(
  'frontend',
  COLORS.frontend,
  ['--prefix', 'frontend', 'run', 'dev'],
  { filterViteProxy: true },
);

frontend.on('exit', (code) => {
  if (!shuttingDown) {
    note(`frontend exited (code ${code ?? 0}) — stopping backend.`);
  }
  shutdown('SIGTERM');
  process.exit(code ?? 0);
});
