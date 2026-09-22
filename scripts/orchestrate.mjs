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
// Mid-session backend restarts (tsc -w → emit → the dev runner's own dist/
// watch-and-restart loop in backend/scripts/dev.mjs, which defers while a
// run.lock is held) are handled by the existing client-side retry/reconnect
// logic.

import { killTree, startChild } from './orchestrate/children.mjs';
import {
  BACKEND_DIR,
  COLORS,
  FRONTEND_DIR,
  HEALTH_TIMEOUT_MS,
  HEALTH_URL,
  note,
} from './orchestrate/config.mjs';
import { recordExit } from './orchestrate/devLog.mjs';
import { waitForHealth } from './orchestrate/health.mjs';
import { describeExitCode } from '../backend/scripts/dev/exitStatus.mjs';

note('starting backend...');
const backend = startChild('backend', COLORS.backend, ['run', 'dev'], {
  cwd: BACKEND_DIR,
});

let shuttingDown = false;
let shutdownDone = null; // the one in-flight shutdown, shared by every trigger
let frontend = null;

// On Windows `killTree` first waits for a child's OWN exit (the dev runner is
// shutting down its terminal-server on the same Ctrl+C) before `taskkill /F`,
// so exiting this process must wait for it — otherwise the pending force-kill
// never runs and the tree is orphaned.
function shutdown(signal) {
  if (!shutdownDone) {
    shuttingDown = true;
    shutdownDone = Promise.all([
      killTree(backend, signal),
      frontend ? killTree(frontend, signal) : Promise.resolve(),
    ]).then(() => {});
  }
  return shutdownDone;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

backend.on('exit', (code, signal) => {
  const cause = describeExitCode(code, signal);
  const log = recordExit('backend', code ?? 0, { expected: shuttingDown, detail: cause });
  if (!shuttingDown) {
    note(`backend exited (${cause}) — stopping frontend.`);
    note(
      log
        ? `last backend output appended to ${log}; crash details in ~/.lattice/logs/crash-*.log`
        : 'crash details (if any) in ~/.lattice/logs/',
    );
  }
  void shutdown('SIGTERM').then(() => process.exit(code ?? 0));
});

const ready = await waitForHealth(HEALTH_URL, HEALTH_TIMEOUT_MS);
if (!ready) {
  note(
    `backend did not respond on ${HEALTH_URL} within ${HEALTH_TIMEOUT_MS / 1000}s — starting frontend anyway.`,
  );
} else {
  note('backend healthy. starting frontend...');
}

frontend = startChild('frontend', COLORS.frontend, ['run', 'dev'], {
  cwd: FRONTEND_DIR,
  filterViteProxy: true,
});

frontend.on('exit', (code, signal) => {
  const cause = describeExitCode(code, signal);
  const log = recordExit('frontend', code ?? 0, { expected: shuttingDown, detail: cause });
  if (!shuttingDown) {
    note(`frontend exited (${cause}) — stopping backend.`);
    if (log) note(`last frontend output appended to ${log}`);
  }
  void shutdown('SIGTERM').then(() => process.exit(code ?? 0));
});
