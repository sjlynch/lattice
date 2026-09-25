#!/usr/bin/env node
//
// `npm run dev` entrypoint: preflight, then the orchestrator — and again, from
// fresh processes, whenever the orchestrator exits with RESTART_EXIT_CODE (the
// dev console's `r` soft restart). Re-running both is what makes a soft restart
// pick up edits to the dev scripts themselves and dependencies that changed
// while the stack was up; the detached terminal-server is never touched here,
// so the next backend re-adopts every live agent pty.
//
// Deliberately tiny and dependency-free: it is the one dev process that is NOT
// replaced by a soft restart, so any change to it needs a full Ctrl+C restart.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shutdownTerminalServer } from '../backend/scripts/dev/backendLifecycle.mjs';
import { note } from './orchestrate/config.mjs';
import { afterPreflight, relaunchAfterOrchestrator } from './orchestrate/devControl.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let current = null;
let interrupted = false;

// Ctrl+C reaches every process on the console (Windows) / in the foreground
// group (POSIX); the child handles it. This process only has to stay alive
// until the child has finished its own shutdown, then stop looping.
process.on('SIGINT', () => {
  interrupted = true;
});
process.on('SIGTERM', () => {
  interrupted = true;
  try {
    current?.kill('SIGTERM');
  } catch {
    /* ignore */
  }
});

function run(script) {
  return new Promise((resolve) => {
    // process.execPath directly: no npm/shell layer (and no DEP0190).
    const child = spawn(process.execPath, [path.join(HERE, script)], { stdio: 'inherit' });
    current = child;
    child.on('exit', (code, signal) => {
      current = null;
      resolve(signal ? null : code);
    });
    child.on('error', (err) => {
      current = null;
      console.error(`[lattice] could not start ${script}:`, err);
      resolve(1);
    });
  });
}

// Ctrl+C between two stacks (during a soft restart's preflight): no dev runner
// is alive to send the terminal-server the `/shutdown` a full stop means.
async function stopFromGap(softRestart, code) {
  if (softRestart) await shutdownTerminalServer();
  process.exit(code ?? 130);
}

let softRestart = false;
for (;;) {
  const preflight = await run('preflight.mjs');
  if (interrupted) await stopFromGap(softRestart, preflight);
  const next = afterPreflight(preflight, { softRestart });
  if (next === 'exit') process.exit(preflight ?? 1);
  if (next === 'continue-degraded') {
    note(
      `preflight could not repair dependencies (exit ${preflight}) — starting the dev stack anyway on the ` +
        'current node_modules, which the previous stack was already running on. See the output above.',
    );
  }
  const code = await run('orchestrate.mjs');
  if (interrupted) process.exit(code ?? 130);
  if (relaunchAfterOrchestrator(code) === 'exit') process.exit(code ?? 1);
  softRestart = true;
}
