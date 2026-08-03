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

import { createBackendLifecycle, shutdownTerminalServer } from './dev/backendLifecycle.mjs';
import {
  copyAssetsBeforeRespawn,
  copyAssetsScript,
  resolveTscBin,
  runInitialCompile,
  runInitialCopyAssets,
  startTscWatch,
} from './dev/compileAssets.mjs';
import { selfHealDeps } from './dev/deps.mjs';
import { watchDist } from './dev/distWatcher.mjs';
import { createRestartPolicy } from './dev/restartPolicy.mjs';

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
// *defer* the restart until that lock clears. On a crash of dist/index.js
// (not a deliberate restart) we behave like `node --watch`: stay up and
// wait for the next dist/ change to retry.

const tscWatch = startTscWatch(tscBin);

let shuttingDown = false;
let closeDistWatch = () => {};

let backendLifecycle;
let restartPolicy;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    closeDistWatch();
  } catch {
    /* ignore */
  }
  restartPolicy.stopDeferredPoll();
  await shutdownTerminalServer();
  for (const c of [tscWatch]) {
    if (!c) continue;
    try {
      c.kill(signal);
    } catch {
      /* ignore */
    }
  }
  backendLifecycle.kill(signal);
}

async function onExit(code) {
  await shutdown('SIGTERM');
  process.exit(code ?? 0);
}

backendLifecycle = createBackendLifecycle({
  copyAssetsBeforeRespawn: () => copyAssetsBeforeRespawn(copyAssetsScript),
  isShuttingDown: () => shuttingDown,
  onExitDuringShutdown: onExit,
});

restartPolicy = createRestartPolicy({
  restartBackend: backendLifecycle.restartBackend,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}

// If tsc -w dies, that's fatal (no more incremental compiles) — bail.
tscWatch.on('exit', onExit);

backendLifecycle.start();

// Don't arm the dist/ watcher until tsc -w has finished its initial
// compile. Without this, every cold boot looks like:
//   1. runInitialCompile populates dist/
//   2. backend spawns (serves from current dist/)
//   3. tsc -w finishes its FIRST watch-mode compile and re-emits dist/
//      (bumps mtimes even when the bytes are identical)
//   4. dist/ watcher fires → backend forced-restart
//   5. The user's browser, opened in step 2-4, races into the restart
//      gap and gets a stream of ECONNREFUSED / 502 from the proxy —
//      surfacing as "stuck on scanning" because /api/scan keeps failing.
// startTscWatch attaches a `tscSettledPromise` that resolves on the
// "Watching for file changes." line tsc -w prints after every compile.
await tscWatch.tscSettledPromise;

// If shutdown signalled while we were waiting, the tsc-exit handler
// resolved the promise — bail before arming the watcher, otherwise we'd
// start a watcher that might fire a restart against an already-shutting-
// down backend lifecycle.
if (!shuttingDown) {
  // Baseline dist/'s newest mtime as of right now, so the watcher can tell a
  // real rebuild from the metadata-only events Windows also delivers (NTFS
  // last-access flush, an AV/indexer scan, an ACL refresh). Those used to
  // restart the backend for nothing — see dev/distSignature.mjs.
  restartPolicy.resetDistBaseline();
  closeDistWatch = await watchDist(restartPolicy.scheduleDistChanged);
  restartPolicy.startDeferredPoll();
}
