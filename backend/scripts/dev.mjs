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

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendLifecycle, shutdownTerminalServer } from './dev/backendLifecycle.mjs';
import {
  copyAssetsBeforeRespawn,
  copyAssetsScript,
  resolveTscBin,
  runInitialCompile,
  runInitialCopyAssets,
} from './dev/compileAssets.mjs';
import { selfHealDeps } from './dev/deps.mjs';
import { watchDist } from './dev/distWatcher.mjs';
import { createRestartPolicy } from './dev/restartPolicy.mjs';
import { createRestartHandshake } from './dev/restartHandshake.mjs';
import { createCompilerLifecycle } from './dev/compilerLifecycle.mjs';
import { distContentSignature } from './dev/distSignature.mjs';
import { createDepsWatcher, runNpmInstall } from '../../scripts/depsWatch.mjs';
import {
  DEPS_RECHECK,
  DEV_CONTROL_ENV,
  DEV_CONTROL_STDIN,
  SOFT_STOP,
  readLines,
} from '../../scripts/orchestrate/devControl.mjs';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- Control channel ----
//
// Under the root orchestrator this process's stdin is a control pipe, not the
// console: `soft-stop` (the dev console's `r` / `d`) stops everything here
// EXCEPT the detached terminal-server, so its agent ptys survive to be
// re-adopted by the next backend; `deps-recheck` (`i`) re-runs the dependency
// check below. The env var is removed at once so it never reaches
// dist/index.js, which passes its env on to every agent pty.
// See scripts/orchestrate/devControl.mjs.
const controlled = process.env[DEV_CONTROL_ENV] === DEV_CONTROL_STDIN;
delete process.env[DEV_CONTROL_ENV];
// Before the backend exists there is nothing to keep alive and nothing to
// stop cleanly: a soft stop during the deps repair / initial compile just exits.
let onControlLine = (line) => {
  if (line.trim() !== SOFT_STOP) return;
  console.log('[lattice-backend] soft stop before the backend started — exiting.');
  process.exit(0);
};
if (controlled) readLines(process.stdin, (line) => onControlLine(line));

// ---- Step 1: self-heal deps if needed ----

await selfHealDeps();

// ---- Step 2: initial compile + static assets ----
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
// We re-run copy-assets on every backend respawn (see backendLifecycle.mjs),
// so a merge that *introduces* a new src asset gets it copied into dist/
// at the next restart instead of waiting for the next session. The initial
// run here is just so the first spawn already has everything.

const tscBin = resolveTscBin();
await runInitialCompile(tscBin);
await runInitialCopyAssets(copyAssetsScript);

// ---- Step 3: watch + run ----
//
// tsc -w emits dist/ on every save. We run dist/index.js and restart it
// when dist/ changes — but a Lattice *merge run* (and a manual /merge)
// executes inside that process, and a mid-run restart kills it. (It
// auto-resumes on the next boot, so the run still completes — but a
// "merge all" would otherwise churn through several restarts, since each
// merged task fast-forwards `main` with a backend/src change.) So while
// any ~/.lattice/per-project/*/run.lock is held by a live process, we
// *defer* the restart until that lock clears — and before applying ANY
// restart we ask the backend to drain first (dev/restartHandshake.mjs:
// no new spawns/runs, in-flight transitions land, state flushed; fail open).
// On a crash of dist/index.js (not a deliberate restart) we respawn it after
// a backoff (dev/backendLifecycle.mjs), or at once on the next dist/ change.

let shuttingDown = false;
let closeDistWatch = () => {};

let backendLifecycle;
let restartPolicy;
let compilerLifecycle;
let backendDeps = null;
// A backend dependency install finished: the next successful compile must
// restart the backend even if dist/ came out byte-identical (a bumped runtime
// dep changes nothing in dist/ but everything the running process loaded).
let depsRestartPending = false;

// The one in-flight shutdown, shared by every trigger. On Windows Ctrl+C
// reaches dist/index.js too, so it can exit while the terminal-server
// `/shutdown` POST below is still in flight; its exit handler (onExit) must
// wait for that POST rather than `process.exit` over it.
let shutdownDone = null;
// The terminal-server `/shutdown`, sent at most once — and only by a REAL stop.
let terminalShutdown = null;
const shutdownTerminalsOnce = () => (terminalShutdown ??= shutdownTerminalServer());

// `keepTerminals`: the soft stop — everything goes except the terminal-server,
// whose sessions the next backend re-adopts exactly as after a dist/ restart
// (killing dist/index.js is a plain TerminateProcess, never a tree kill, so the
// detached server it once spawned is not taken with it). A real stop arriving
// during a soft one (Ctrl+C right after `r`) still sends the `/shutdown`.
function shutdown(signal, { keepTerminals = false } = {}) {
  if (!shutdownDone) {
    shuttingDown = true;
    shutdownDone = (async () => {
      try {
        closeDistWatch();
      } catch {
        /* ignore */
      }
      backendDeps?.close();
      restartPolicy.stopDeferredPoll();
      compilerLifecycle?.stop(signal);
      if (!keepTerminals) await shutdownTerminalsOnce();
      backendLifecycle.kill(signal);
      // No backend to wait for (it crashed and is waiting for a dist/ change):
      // nothing will call onExit, and the control pipe keeps this process up.
      // Deferred a turn: this body can finish synchronously (a soft stop never
      // awaits), before `shutdownDone` is even assigned.
      if (backendLifecycle.needsStart()) setImmediate(() => void onExit(0));
    })();
  }
  if (!keepTerminals) void shutdownTerminalsOnce();
  return shutdownDone;
}

async function onExit(code) {
  // Only ever called once a stop is under way. Never shutdown() here: its
  // default is a full stop, which would turn a soft stop into one.
  await shutdownDone;
  if (terminalShutdown) await terminalShutdown;
  process.exit(code ?? 0);
}

backendLifecycle = createBackendLifecycle({
  copyAssetsBeforeRespawn: () => copyAssetsBeforeRespawn(copyAssetsScript),
  isShuttingDown: () => shuttingDown,
  onExitDuringShutdown: onExit,
  canSpawnBackend: () => !compilerLifecycle || compilerLifecycle.canRestartBackend(),
  captureBackendVersion: () => restartPolicy.captureDistBaseline(),
  onBackendSpawned: (candidate) => restartPolicy.onBackendSpawned(candidate),
});

const restartHandshake = createRestartHandshake();

restartPolicy = createRestartPolicy({
  restartBackend: backendLifecycle.restartBackend,
  canRestart: () => !shuttingDown && Boolean(compilerLifecycle?.canRestartBackend()),
  needsBackendStart: backendLifecycle.needsStart,
  readDistContentSignature: distContentSignature,
  deferBaselineUntilSpawn: true,
  prepareRestart: restartHandshake.prepare,
  cancelRestartDrain: restartHandshake.cancel,
  queryLockHolders: restartHandshake.lockHolders,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

onControlLine = (line) => {
  const command = line.trim();
  if (command === SOFT_STOP) {
    if (shuttingDown) return;
    console.log(
      '[lattice-backend] soft stop — stopping the backend and compiler; the terminal-server and its ' +
        'agent terminals keep running.',
    );
    void shutdown('SIGTERM', { keepTerminals: true });
  } else if (command === DEPS_RECHECK) {
    if (backendDeps) void backendDeps.recheck({ force: true });
    else console.log('[lattice-backend] deps: the dependency watch is not running yet.');
  }
};

// The one-shot compile already produced a complete backend. Start it before
// the watch compiler so a compiler-only failure never removes a working app.
restartPolicy.resetDistBaseline();
backendLifecycle.start();
compilerLifecycle = createCompilerLifecycle({
  tscBin,
  onCompileSucceeded: () => {
    restartPolicy.onCompileSucceeded();
    if (depsRestartPending && !shuttingDown) {
      depsRestartPending = false;
      // Forced past the "did dist/ change?" check, never past run.lock deferral.
      restartPolicy.onDistChanged(true);
    }
  },
});

// ---- Dependency changes after boot ----
//
// A merge that lands a package.json / package-lock.json change would otherwise
// leave `tsc -w` failing "Cannot find module" (and the backend silently on its
// old code) until the next full restart. Install, restart the compiler so it
// re-resolves node_modules, and let its successful compile restart the backend
// through the restart policy. A failed install is logged (console +
// dev-runner.log) and not retried until the files change again. See
// scripts/depsWatch.mjs.
backendDeps = createDepsWatcher({
  dir: BACKEND_DIR,
  label: 'backend',
  log: (msg) => console.log(`[lattice-backend] deps: ${msg}`),
  warn: (msg) => console.warn(`[lattice-backend] deps: ${msg}`),
  install: ({ recordLabel }) =>
    runNpmInstall({
      cwd: BACKEND_DIR,
      recordLabel,
      forward: (line, stream) => process[stream].write(`[npm:backend] ${line}\n`),
    }),
  afterInstall: ({ ok }) => {
    if (!ok || shuttingDown) return;
    depsRestartPending = true;
    console.log(
      '[lattice-backend] deps: recompiling against the new node_modules, then restarting the backend ' +
        '(still deferred while a run.lock is held).',
    );
    compilerLifecycle.restart('backend dependencies changed');
  },
});

// Dist events are fenced while the compiler starts, compiles, reports errors,
// or repairs. Its zero-error completion is also an explicit catch-up signal,
// so a missed native event cannot hide edits made during compiler downtime.
const close = await watchDist(restartPolicy.scheduleDistChanged);
if (shuttingDown) close();
else {
  closeDistWatch = close;
  restartPolicy.startDeferredPoll();
  compilerLifecycle.start();
  backendDeps.start();
}
