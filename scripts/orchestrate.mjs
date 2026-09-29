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
//
// Run by `scripts/devLoop.mjs`, which re-runs preflight + this script when it
// exits with RESTART_EXIT_CODE — the dev console's soft restart (`r`), which
// stops both children WITHOUT the terminal-server `/shutdown` so live agent
// ptys are re-adopted by the next backend. Ctrl+C stays a full stop. See
// orchestrate/devControl.mjs. Root/frontend dependency changes after boot are
// installed here too (depsWatch.mjs); the backend runner owns its own.

import { killTree, startChild } from './orchestrate/children.mjs';
import {
  BACKEND_DIR,
  COLORS,
  FRONTEND_DIR,
  HEALTH_TIMEOUT_MS,
  HEALTH_URL,
  ROOT,
  note,
} from './orchestrate/config.mjs';
import { stdoutSink } from './orchestrate/consoleSink.mjs';
import {
  CONSOLE_HELP,
  CONSOLE_HINT,
  DEPS_RECHECK,
  DEV_CONTROL_ENV,
  DEV_CONTROL_STDIN,
  RESTART_EXIT_CODE,
  SOFT_STOP,
  SOFT_STOP_TIMEOUT_MS,
  forwardedExitCode,
  parseConsoleCommand,
  readLines,
  waitForExit,
} from './orchestrate/devControl.mjs';
import { recordExit } from './orchestrate/devLog.mjs';
import { waitForHealth } from './orchestrate/health.mjs';
import { createDepsWatcher, runNpmInstall } from './depsWatch.mjs';
import { shutdownTerminalServer } from '../backend/scripts/dev/backendLifecycle.mjs';
import { describeExitCode } from '../backend/scripts/dev/exitStatus.mjs';
import { describeRunLocks, heldRunLocks } from '../backend/scripts/dev/restartPolicy.mjs';

note('starting backend...');
// The runner's stdin is our control pipe (soft stop, deps re-check) — the
// console's keystrokes are read here, not by it. See devControl.mjs.
const backend = startChild('backend', COLORS.backend, ['run', 'dev'], {
  cwd: BACKEND_DIR,
  stdin: 'pipe',
  env: { ...process.env, [DEV_CONTROL_ENV]: DEV_CONTROL_STDIN },
});
// A dead runner must not crash us on the next command (EPIPE).
backend.stdin?.on('error', () => {});

let shuttingDown = false;
let shutdownDone = null; // the one in-flight shutdown, shared by every trigger
// null while running; 'full' (Ctrl+C / a child died), 'restart' or 'detach'.
let stopMode = null;
// A full stop overwrites stopMode, so remember separately that a soft stop is
// still running and will exit this process itself.
let softStopInFlight = false;
let frontend = null;
// vite children we stopped on purpose (a dependency install): their exit is
// not "the frontend died".
const retiredFrontends = new WeakSet();
const depsWatchers = [];

// On Windows `killTree` first waits for a child's OWN exit (the dev runner is
// shutting down its terminal-server on the same Ctrl+C) before `taskkill /F`,
// so exiting this process must wait for it — otherwise the pending force-kill
// never runs and the tree is orphaned.
function shutdown(signal) {
  if (!shutdownDone) {
    shuttingDown = true;
    // Ctrl+C always wins, including over a soft stop already in flight (the
    // dev runner gets the same console break and upgrades its own stop).
    stopMode = 'full';
    closeDepsWatchers();
    shutdownDone = Promise.all([
      killTree(backend, signal),
      frontend ? killTree(frontend, signal) : Promise.resolve(),
    ]).then(() => {});
  }
  return shutdownDone;
}

// How long a full stop waits, after the tree kills, for the children's own
// 'exit' before exiting anyway.
const FULL_STOP_EXIT_MS = 5000;

// Every other exit hangs off a child's 'exit' event. A child that outlives its
// taskkill left this process alive for days, still reading the console and
// answering the user's next `npm run dev` with "unknown command" (2026-09-29).
// Once it exits, the children's pipes close and a lingering shell ends too.
async function exitAfterFullStop(signal) {
  // A soft stop in flight owns the exit: it still has to POST the
  // terminal-server `/shutdown` a full stop means, and its waits are bounded.
  if (softStopInFlight) return;
  await Promise.all([
    waitForExit(backend, FULL_STOP_EXIT_MS),
    frontend ? waitForExit(frontend, FULL_STOP_EXIT_MS) : Promise.resolve(true),
  ]);
  await settleConsole();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void shutdown(sig).then(() => exitAfterFullStop(sig));
  });
}

backend.on('exit', (code, signal) => {
  const cause = describeExitCode(code, signal);
  const log = recordExit('backend', code ?? 0, { expected: shuttingDown || stopMode !== null, detail: cause });
  // A soft stop owns its own exit (softStop below).
  if (stopMode === 'restart' || stopMode === 'detach') return;
  if (!shuttingDown) {
    note(`backend exited (${cause}) — stopping frontend.`);
    note(
      log
        ? `last backend output appended to ${log}; crash details in ~/.lattice/logs/crash-*.log`
        : 'crash details (if any) in ~/.lattice/logs/',
    );
  }
  void shutdown('SIGTERM').then(() => process.exit(forwardedExitCode(code)));
});

function startFrontend() {
  const child = startChild('frontend', COLORS.frontend, ['run', 'dev'], {
    cwd: FRONTEND_DIR,
    filterViteProxy: true,
    // Not the console: this process reads the dev-console commands, and two
    // readers of one console split its lines unpredictably. (This drops vite's
    // own h/r/o/q shortcuts, which only ever worked when vite won that race.)
    // A pipe we never write, NOT 'ignore': vite closes its server when stdin
    // ENDS (its parent-death signal), and an ignored stdin ends at once. The
    // pipe ends only when this process is gone — the same signal, kept true.
    stdin: 'pipe',
  });
  child.stdin?.on('error', () => {});
  frontend = child;
  child.on('exit', (code, signal) => {
    const cause = describeExitCode(code, signal);
    const retired = retiredFrontends.has(child);
    const log = recordExit('frontend', code ?? 0, {
      expected: shuttingDown || stopMode !== null || retired,
      detail: cause,
    });
    if (retired || stopMode === 'restart' || stopMode === 'detach') return;
    if (!shuttingDown) {
      note(`frontend exited (${cause}) — stopping backend.`);
      if (log) note(`last frontend output appended to ${log}`);
    }
    void shutdown('SIGTERM').then(() => process.exit(forwardedExitCode(code)));
  });
  return child;
}

// Stop the current vite on purpose (a dependency install or a soft stop).
async function stopFrontend() {
  const child = frontend;
  if (!child) return;
  retiredFrontends.add(child);
  // vite has nothing to flush — no grace period.
  await killTree(child, 'SIGTERM', { graceMs: 0 });
  await waitForExit(child, 5000);
}

function sendControl(line) {
  try {
    if (backend.stdin && !backend.stdin.destroyed && backend.exitCode === null) {
      backend.stdin.write(`${line}\n`);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

// Let the async console sink put a final line on screen before process.exit.
const settleConsole = () => new Promise((resolve) => setTimeout(resolve, 150));

function blockingRunLocks() {
  try {
    return heldRunLocks();
  } catch {
    return [];
  }
}

// `r` / `d`: stop the backend runner (which kills dist/index.js — a plain
// TerminateProcess, never a tree kill, so the detached terminal-server it
// spawned lives on) and vite, WITHOUT the terminal-server `/shutdown`.
async function softStop(mode, { force = false } = {}) {
  if (stopMode) {
    note(`already stopping (${stopMode}).`);
    return;
  }
  const key = mode === 'restart' ? 'r' : 'd';
  if (!force) {
    const locks = blockingRunLocks();
    if (locks.length > 0) {
      note(
        `a run.lock is held (${describeRunLocks(locks)}) — stopping the backend now interrupts that ` +
          'in-process run (a merge run auto-resumes on the next boot; a workflow control step is re-run or ' +
          `stranded). Type ${key}! to go ahead anyway, or wait for it to finish.`,
      );
      return;
    }
  }
  stopMode = mode;
  softStopInFlight = true;
  closeDepsWatchers();
  note(
    mode === 'restart'
      ? 'soft restart: stopping the backend + vite; the terminal-server and its agent terminals keep running...'
      : 'detaching: stopping the backend + vite; the terminal-server and its agent terminals keep running...',
  );
  const backendStopped = waitForExit(backend, SOFT_STOP_TIMEOUT_MS);
  if (!sendControl(SOFT_STOP)) note('could not reach the backend dev runner — waiting for it to exit...');
  const frontendStopped = stopFrontend();
  if (!(await backendStopped)) {
    // By now dist/index.js is almost certainly gone, and with it the only
    // process-tree link to the terminal-server — so the tree kill below cannot
    // reach the agents. Say so anyway: this is the one path that could.
    note(
      `the backend dev runner did not finish its soft stop in ${SOFT_STOP_TIMEOUT_MS / 1000}s — ` +
        'force-killing its process tree.',
    );
    await killTree(backend, 'SIGTERM', { graceMs: 0 });
    await waitForExit(backend, 5000);
  }
  await frontendStopped;
  if (stopMode === 'full') {
    // Ctrl+C landed mid-soft-stop. If the runner had already exited (keeping
    // the terminal-server), nobody else will send the `/shutdown` a full stop
    // means; if it hasn't, this is a no-op against a server already gone.
    await shutdownTerminalServer();
    await shutdown('SIGINT');
    await settleConsole();
    process.exit(130);
  }
  if (mode === 'restart') {
    note('stopped — re-running preflight and starting the dev stack again...');
    await settleConsole();
    process.exit(RESTART_EXIT_CODE);
  }
  note(
    'detached. The terminal-server keeps its agent terminals running; the next `npm run dev` re-adopts ' +
      'them. It exits on its own once it has no sessions and no backend.',
  );
  await settleConsole();
  process.exit(0);
}

function closeDepsWatchers() {
  for (const watcher of depsWatchers.splice(0)) watcher.close();
}

function startDepsWatchers() {
  const depsNote = (msg) => note(`deps: ${msg}`);
  const forward = (label) => (line) =>
    stdoutSink.write(`${COLORS.lattice}[npm:${label}]${COLORS.reset} ${line}\n`);
  depsWatchers.push(
    createDepsWatcher({
      dir: ROOT,
      label: 'root',
      log: depsNote,
      warn: depsNote,
      install: ({ recordLabel }) => runNpmInstall({ cwd: ROOT, recordLabel, forward: forward('root') }),
    }),
    createDepsWatcher({
      dir: FRONTEND_DIR,
      label: 'frontend',
      log: depsNote,
      warn: depsNote,
      install: ({ recordLabel }) =>
        runNpmInstall({ cwd: FRONTEND_DIR, recordLabel, forward: forward('frontend') }),
      // vite (and its esbuild service) hold files the install may replace —
      // on Windows a loaded native binary can't be — so stop it first. Only
      // vite restarts; the backend and every agent are untouched.
      beforeInstall: async () => {
        if (stopMode) return;
        note('stopping vite for the frontend install (backend + agents keep running)...');
        await stopFrontend();
      },
      afterInstall: () => {
        if (stopMode) return;
        note('restarting vite...');
        startFrontend();
      },
    }),
  );
  for (const watcher of depsWatchers) watcher.start();
}

function onConsoleLine(line) {
  // After Ctrl+C, npm hands the prompt back while this process is still
  // stopping, so a line typed now is meant for the shell, not for us.
  if (stopMode === 'full') return;
  const cmd = parseConsoleCommand(line);
  switch (cmd.kind) {
    case 'none':
      return;
    case 'help':
      for (const text of CONSOLE_HELP) note(text);
      return;
    case 'restart':
    case 'detach':
      void softStop(cmd.kind, { force: cmd.force });
      return;
    case 'deps':
      if (stopMode) return;
      note('re-checking dependencies (root, frontend, backend)...');
      for (const watcher of depsWatchers) void watcher.recheck({ force: true });
      if (!sendControl(DEPS_RECHECK)) note('could not reach the backend dev runner for its re-check.');
      return;
    default:
      note(`unknown command "${cmd.text}" — ${CONSOLE_HINT}`);
  }
}

// Console commands only from a real console: a piped/redirected stdin is not
// someone typing. LATTICE_DEV_CONSOLE_STDIN=1 opts a piped stdin in, for a
// test driver that types the commands itself (an isolated dev-stack e2e).
const consoleInput = process.stdin.isTTY || process.env.LATTICE_DEV_CONSOLE_STDIN === '1';
if (consoleInput) readLines(process.stdin, onConsoleLine);

const ready = await waitForHealth(HEALTH_URL, HEALTH_TIMEOUT_MS);
if (stopMode) {
  // A soft stop or a full stop landed during the boot wait; it owns the exit.
} else {
  if (!ready) {
    note(
      `backend did not respond on ${HEALTH_URL} within ${HEALTH_TIMEOUT_MS / 1000}s — starting frontend anyway.`,
    );
  } else {
    note('backend healthy. starting frontend...');
  }
  startFrontend();
  startDepsWatchers();
  if (consoleInput) note(CONSOLE_HINT);
}
