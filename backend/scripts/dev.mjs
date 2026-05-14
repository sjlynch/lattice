#!/usr/bin/env node
//
// Dev runner for the Lattice backend.
//
// Strategy:
//   1. Self-heal: if node_modules is incomplete, auto-run `npm install`
//      so a wiped or partially-installed deps tree doesn't crash the
//      boot with a confusing stack trace.
//   2. Compile TypeScript once to dist/, copy non-TS assets, then watch:
//        - tsc -w  → emits dist/ on every save (skips emit on type error)
//        - our own watch+restart loop over dist/ → restarts dist/index.js
//          on a change, EXCEPT while a Lattice merge run (or manual /merge)
//          holds a per-project run.lock — those execute inside the backend
//          process, so a mid-run restart would interrupt them. We defer
//          the restart until the lock clears. (`node --watch` can't do
//          this, hence the hand-rolled loop.)
//      Plain `node` (no loader injection) is intentional: tsx-style
//      runtimes set NODE_OPTIONS to inject a TS loader that propagates
//      to every child_process the backend spawns. That has caused two
//      separate classes of bug here:
//        - node-pty's per-pty Windows helper crashes when it inherits a
//          TS loader and resolves the helper to its .ts source.
//        - tsx's own preflight bundle has been observed to fail booting
//          when its transitive deps drift in node_modules.
//      Compiling once and running plain Node sidesteps both.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const inheritStdio = ['inherit', 'inherit', 'inherit'];

// ---- Step 1: self-heal deps if needed ----

const REQUIRED_PKGS = [
  'typescript',
  'express',
  'cors',
  'ws',
  'node-pty',
  'ignore',
  'chokidar',
];

function hasPkg(name) {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function npmCmd() {
  // .cmd shim on Windows can't be spawned without a shell since Node 20.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runOnce(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, opts);
    c.on('exit', (code) => resolve(code ?? 0));
    c.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });
}

const missing = REQUIRED_PKGS.filter((p) => !hasPkg(p));
if (missing.length > 0) {
  console.log(
    `[lattice-backend] missing ${missing.length} dep(s) (${missing.join(', ')}) — running 'npm install' to repair...`,
  );
  const code = await runOnce(npmCmd(), ['install'], {
    stdio: inheritStdio,
    shell: process.platform === 'win32',
  });
  if (code !== 0) {
    console.error(
      `[lattice-backend] 'npm install' exited with ${code}. Resolve manually and retry.`,
    );
    process.exit(code);
  }
}

// ---- Step 2: initial compile ----

const tscBin = require.resolve('typescript/lib/tsc.js');

console.log('[lattice-backend] initial compile...');
const initialCode = await runOnce(process.execPath, [tscBin], {
  stdio: 'inherit',
});
if (initialCode !== 0) {
  console.error(
    `[lattice-backend] initial tsc exited ${initialCode}. Fix type errors and retry.`,
  );
  process.exit(initialCode);
}

// ---- Step 2b: copy non-TS static assets into dist/ ----
//
// `tsc` only emits .js for .ts inputs. Runtime assets that live under src/
// (for example src/workflowRuns/create-task-template.cjs and
// src/latticeApiDocs/LATTICE_API.template.md) won't be in dist/ otherwise —
// and the backend then crashes on startup the moment it tries to read one. `npm run build`
// already does this (`tsc && node scripts/copy-assets.mjs`); the dev runner
// must run the *same* asset-copy step, or `npm run dev` and `npm run build`
// produce different dist/ trees. This is what failed during a "merge all":
// a task introduced create-task-template.cjs, dist/ recompiled without it,
// and the next `node --watch` restart died with ENOENT.
//
// Assets are copied once here. They're effectively static; if you edit one
// while `npm run dev` is up, restart it.
const copyAssetsScript = fileURLToPath(new URL('./copy-assets.mjs', import.meta.url));
const copyAssetsCode = await runOnce(process.execPath, [copyAssetsScript], {
  stdio: 'inherit',
});
if (copyAssetsCode !== 0) {
  console.error(
    `[lattice-backend] copy-assets exited ${copyAssetsCode}. The backend would crash on boot — aborting.`,
  );
  process.exit(copyAssetsCode);
}

// ---- Step 3: watch + run ----
//
// tsc -w emits dist/ on every save. We run dist/index.js and restart it
// when dist/ changes — but a Lattice *merge run* (and a manual /merge)
// executes inside that process, and a mid-run restart kills it. (It
// auto-resumes on the next boot, so the run still completes — but a
// "merge all" would otherwise churn through several restarts, since each
// merged task fast-forwards `main` with a backend/src change.) So while
// any ~/.lattice/per-project/*/run.lock is held by a live process, we
// *defer* the restart until that lock clears. On a crash of dist/index.js
// (not a deliberate restart) we behave like `node --watch`: stay up and
// wait for the next dist/ change to retry.

const tscWatch = spawn(
  process.execPath,
  [tscBin, '-w', '--preserveWatchOutput'],
  { stdio: inheritStdio },
);

const PER_PROJECT_DIR = path.join(os.homedir(), '.lattice', 'per-project');
const RESTART_DEBOUNCE_MS = 250;
const DEFERRED_RESTART_POLL_MS = 3000;
// Don't defer a restart forever if a run somehow wedges with the lock
// held — after this long, restart anyway (the run is interrupted, then
// auto-resumed on the next boot).
const MAX_DEFER_MS = 15 * 60 * 1000;
const TERMINAL_PORT = Number(process.env.TERMINAL_PORT) || 5185;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err) && err.code !== 'ESRCH'; // EPERM etc → assume alive
  }
}

// True if any Lattice process holds a per-project run.lock (a merge run
// or a manual /merge). Cheap — only read on a dist/ change or the poll.
function repoOperationInFlight() {
  let hashes;
  try {
    hashes = fs.readdirSync(PER_PROJECT_DIR);
  } catch {
    return false; // dir doesn't exist yet → nothing running
  }
  for (const h of hashes) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(PER_PROJECT_DIR, h, 'run.lock'), 'utf8');
    } catch {
      continue;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      continue;
    }
    if (body && typeof body.pid === 'number' && pidAlive(body.pid)) return true;
  }
  return false;
}

let backendChild = null;
let restartingBackend = false; // true between a restart kill and the respawn
let shuttingDown = false;
let deferredSince = 0; // ms ts of the first deferred restart, or 0

function spawnBackend() {
  restartingBackend = false;
  const c = spawn(process.execPath, ['dist/index.js'], { stdio: inheritStdio });
  c.on('exit', (code, signal) => {
    if (restartingBackend) {
      restartingBackend = false;
      backendChild = spawnBackend();
      return;
    }
    if (shuttingDown) {
      void onExit(code ?? 0);
      return;
    }
    // Exited on its own (a crash, or a fatal startup error) — mirror
    // `node --watch`: stay up and wait for the next dist/ change to retry.
    console.error(
      `[lattice-backend] dist/index.js exited (${signal ? `signal ${signal}` : `code ${code}`}) — ` +
        `waiting for a dist/ change to retry...`,
    );
    backendChild = null;
  });
  return c;
}

function restartBackend(reason) {
  if (restartingBackend) return; // a restart is already in flight
  deferredSince = 0;
  if (!backendChild) {
    console.log(`[lattice-backend] starting dist/index.js — ${reason}`);
    backendChild = spawnBackend();
    return;
  }
  console.log(`[lattice-backend] restarting dist/index.js — ${reason}`);
  restartingBackend = true;
  try {
    backendChild.kill();
  } catch {
    restartingBackend = false;
    backendChild = spawnBackend();
  }
}

function onDistChanged() {
  if (repoOperationInFlight()) {
    if (!deferredSince) {
      deferredSince = Date.now();
      console.log(
        '[lattice-backend] dist/ changed during a merge/merge-all run — deferring restart until it finishes ' +
          '(the deferred-restart poll applies it once the run.lock clears).',
      );
    }
    return; // the poll below handles "run finished" and the long-defer backstop
  }
  restartBackend(deferredSince ? 'merge run finished — applying deferred restart' : 'dist/ changed');
}

// Debounce dist/ change bursts — one tsc compile emits many files.
let distDebounceTimer = null;
function scheduleDistChanged() {
  if (distDebounceTimer) clearTimeout(distDebounceTimer);
  distDebounceTimer = setTimeout(() => {
    distDebounceTimer = null;
    onDistChanged();
  }, RESTART_DEBOUNCE_MS);
}

async function watchDist() {
  // fs.watch({recursive}) covers Windows + macOS. On Linux it throws
  // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM — fall back to chokidar there.
  try {
    const w = fs.watch('dist', { recursive: true }, () => scheduleDistChanged());
    console.log('[lattice-backend] watching dist/ (fs.watch)');
    return () => {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* fall through */
  }
  try {
    const mod = await import('chokidar');
    const watch = mod.watch ?? mod.default?.watch ?? mod.default;
    const w = watch('dist', { ignoreInitial: true });
    w.on('all', () => scheduleDistChanged());
    console.log('[lattice-backend] watching dist/ (chokidar)');
    return () => {
      void w.close();
    };
  } catch (err) {
    console.warn(
      '[lattice-backend] could not watch dist/ — auto-restart disabled; restart `npm run dev` after backend changes.',
      err,
    );
    return () => {};
  }
}

// The terminal server (port 5185) is intentionally detached + unref'd by
// the backend (terminalProxy.ts) so PTYs survive backend restarts. The
// downside is the orchestrator killing the backend doesn't take it down,
// so on real shutdown we POST /shutdown ourselves. (NOT on a plain
// restart — that would kill every PTY on each HMR cycle.) Without this,
// every `npm run dev` cycle leaves orphan PTYs (and orphan Claude Code
// processes inside them) running forever.
async function shutdownTerminalServer() {
  try {
    await fetch(`http://127.0.0.1:${TERMINAL_PORT}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    /* terminal server already down */
  }
}

let closeDistWatch = () => {};
let deferPollTimer = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    closeDistWatch();
  } catch {
    /* ignore */
  }
  if (deferPollTimer) clearInterval(deferPollTimer);
  await shutdownTerminalServer();
  for (const c of [tscWatch, backendChild]) {
    if (!c) continue;
    try {
      c.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

async function onExit(code) {
  await shutdown('SIGTERM');
  process.exit(code ?? 0);
}
// If tsc -w dies, that's fatal (no more incremental compiles) — bail.
tscWatch.on('exit', onExit);

backendChild = spawnBackend();
closeDistWatch = await watchDist();
// Once a restart is deferred, the dist/ watcher won't necessarily fire
// again, so poll: apply the deferred restart as soon as the run.lock
// clears, and — as a backstop against a wedged run holding the lock
// forever — force it after MAX_DEFER_MS regardless.
deferPollTimer = setInterval(() => {
  if (!deferredSince) return;
  if (!repoOperationInFlight()) {
    restartBackend('merge run finished — applying deferred restart');
  } else if (Date.now() - deferredSince > MAX_DEFER_MS) {
    console.warn(
      `[lattice-backend] restart deferred for ${Math.round((Date.now() - deferredSince) / 60000)} min — ` +
        `forcing it (an in-flight run will be interrupted and auto-resumed on the next boot).`,
    );
    restartBackend('forced after a long defer');
  }
}, DEFERRED_RESTART_POLL_MS);
deferPollTimer.unref();
