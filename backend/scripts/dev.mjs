#!/usr/bin/env node
//
// Dev runner for the Lattice backend.
//
// Strategy:
//   1. Self-heal: if node_modules is incomplete, auto-run `npm install`
//      so a wiped or partially-installed deps tree doesn't crash the
//      boot with a confusing stack trace.
//   2. Compile TypeScript once to dist/, then watch for changes:
//        - tsc -w  → emits dist/ on every save (skips emit on type error)
//        - node --watch dist/index.js → restarts on dist/ changes
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

// ---- Step 3: watch + run ----

const tscWatch = spawn(
  process.execPath,
  [tscBin, '-w', '--preserveWatchOutput'],
  { stdio: inheritStdio },
);
const nodeRun = spawn(
  process.execPath,
  ['--watch', 'dist/index.js'],
  { stdio: inheritStdio },
);

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of [tscWatch, nodeRun]) {
    try {
      c.kill(signal);
    } catch {
      /* ignore */
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}

function onExit(code) {
  shutdown('SIGTERM');
  process.exit(code ?? 0);
}
tscWatch.on('exit', onExit);
nodeRun.on('exit', onExit);
