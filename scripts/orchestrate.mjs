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
  shutdown('SIGTERM');
  process.exit(code ?? 0);
});
