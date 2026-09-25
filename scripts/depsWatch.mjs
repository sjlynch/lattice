// Dependency changes AFTER boot.
//
// `preflight.mjs` and the backend runner's `selfHealDeps` only check
// node_modules at startup. A merge that fast-forwards `main` with a changed
// package.json / package-lock.json then broke the running stack silently:
// `tsc -w` failed "Cannot find module" (noEmitOnError → the backend just stayed
// on its old code) and vite could not resolve the new import. This watches a
// workspace's manifest + lockfile and, when `depsCheck.mjs` says the installed
// tree no longer matches them, runs `npm install` IN that workspace (cwd, never
// `--prefix` — see scripts/CLAUDE.md) and hands the result to the owner:
//
//   - root + frontend are owned by the orchestrator (`scripts/orchestrate.mjs`),
//     which stops vite for the install and starts it again afterwards;
//   - backend is owned by `backend/scripts/dev.mjs`, which restarts `tsc -w` and
//     then restarts the backend through its normal restart policy (so run.lock
//     deferral still applies).
//
// Loop guard: npm itself rewrites package-lock.json, so the trigger is a
// MISMATCH, never a file event on its own; and a failed install records the
// manifest+lock signature it was run against and is not retried until those
// files change again (or the user types `i`, which forces a retry). After
// MAX_AUTO_INSTALL_FAILURES failures in a row only a forced retry installs.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { checkWorkspaceDeps, describeStaleDep } from './depsCheck.mjs';
import { classifyInstallFailure, installFailureHint, runNpmInstall } from './npmInstall.mjs';
import { recordExit } from './orchestrate/devLog.mjs';

// The install runner lives in npmInstall.mjs; `backend/scripts/dev.mjs` and the
// tests import it from here.
export { classifyInstallFailure, installFailureHint, runNpmInstall };

export const DEPS_MANIFEST_FILES = ['package.json', 'package-lock.json'];
// A merge writes package.json and package-lock.json a few ms apart, and an
// editor save can land as write + rename. One install per burst.
export const DEPS_WATCH_DEBOUNCE_MS = 2000;
// Back-to-back failed automatic installs before the watcher stops trying on
// its own (until an install succeeds or the user forces one). Belt and braces
// for the signature guard: a failing install that rewrote its own manifest
// would otherwise look like a fresh change every time.
export const MAX_AUTO_INSTALL_FAILURES = 3;

/** Content signature of a workspace's manifest + lockfile ('' for a missing one). */
export function manifestSignature(dir, readFile = fs.readFileSync) {
  const hash = createHash('sha1');
  for (const name of DEPS_MANIFEST_FILES) {
    let body = '';
    try {
      body = readFile(path.join(dir, name), 'utf8');
    } catch {
      /* missing → '' */
    }
    hash.update(name).update('\0').update(body).update('\0');
  }
  return hash.digest('hex');
}

/** Does a directory watch event concern the manifest or lockfile? */
export function isManifestEvent(filename) {
  // No filename: the platform could not say which entry changed. The check is
  // cheap (a handful of small JSON reads), so look rather than miss it.
  if (filename == null || filename === '') return true;
  return DEPS_MANIFEST_FILES.includes(path.basename(String(filename)));
}

/**
 * Pure decision for one evaluation.
 * @returns {'in-step' | 'install' | 'skip-failed'}
 */
export function planDepsAction({ staleCount, signature, failedSignature, force = false, failures = 0 }) {
  if (staleCount === 0) return 'in-step';
  if (force) return 'install';
  if (failedSignature != null && signature === failedSignature) return 'skip-failed';
  if (failures >= MAX_AUTO_INSTALL_FAILURES) return 'skip-failed';
  return 'install';
}

/**
 * Watch one workspace and keep its node_modules in step with its manifests.
 * Never throws into the caller and never exits the process.
 */
export function createDepsWatcher({
  dir,
  label,
  log = (msg) => console.log(msg),
  warn = (msg) => console.warn(msg),
  check = checkWorkspaceDeps,
  signature = manifestSignature,
  install = ({ recordLabel }) => runNpmInstall({ cwd: dir, recordLabel }),
  beforeInstall = async () => {},
  afterInstall = async () => {},
  record = recordExit,
  watch = (target, listener) => fs.watch(target, listener),
  debounceMs = DEPS_WATCH_DEBOUNCE_MS,
  platform = process.platform,
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (timer) => clearTimeout(timer),
}) {
  const recordLabel = `npm-install-${label}`;
  let watcher = null;
  let debounce = null;
  let closed = false;
  let installing = false;
  let current = null; // the in-flight install's handle
  let rerun = false;
  let rerunForce = false;
  let failedSignature = null;
  let failures = 0; // consecutive failed installs
  let skipLogged = false;
  let settled = Promise.resolve();

  function safeCheck() {
    try {
      return check(dir);
    } catch (err) {
      warn(`dependency check for ${label} failed: ${err?.message ?? err}`);
      return null;
    }
  }

  function describeStale(list) {
    return list.map((d) => describeStaleDep(d)).join(', ');
  }

  // Back in step (an install succeeded, or the files settled on their own):
  // forget the failure bookkeeping.
  function markInStep() {
    failedSignature = null;
    failures = 0;
    skipLogged = false;
  }

  function logSkip(sig) {
    if (skipLogged) return;
    skipLogged = true;
    log(
      failedSignature === sig
        ? `${label} dependencies are still out of step, but 'npm install' already failed for these ` +
            'package.json / package-lock.json contents — not retrying until they change (or type `i`).'
        : `${label} dependencies are still out of step after ${failures} failed installs in a row — ` +
            'not retrying automatically (type `i` to retry).',
    );
  }

  /**
   * Announce and run one install (after the owner's `beforeInstall`).
   * @returns {Promise<{ code: number, output: string } | null>} null when the
   *   watcher was closed before the install could start.
   */
  async function runInstall(stale) {
    installing = true;
    log(
      `${label}: ${stale.length} dependency item(s) out of step with package.json / package-lock.json ` +
        `(${describeStale(stale)}) — running 'npm install' in ${label}...`,
    );
    let result;
    try {
      await beforeInstall();
      if (closed) {
        installing = false;
        return null;
      }
      current = install({ recordLabel });
      result = await current.done;
    } catch (err) {
      result = { code: 1, output: String(err?.message ?? err) };
    }
    current = null;
    installing = false;
    return result;
  }

  function reportFailure(result, after, sig) {
    // The files it was RUN against: a merge landing mid-install is a change
    // worth a retry. (A failed npm install rolls back without saving its
    // lockfile, so its own writes don't normally move the signature.)
    failedSignature = sig;
    failures += 1;
    skipLogged = false;
    const failure = classifyInstallFailure(result.output);
    const cause =
      result.code === 0
        ? `exited 0 but ${after?.length ?? '?'} item(s) are still out of step` +
          (after?.length ? ` (${describeStale(after)})` : '')
        : `exited ${result.code}${failure.locked ? ' on a locked file (EBUSY/EPERM)' : ''}`;
    const hint = installFailureHint(failure, platform);
    warn(`'npm install' in ${label} ${cause}.`);
    warn(`hint: ${hint}`);
    try {
      const file = record(recordLabel, result.code === 0 ? 1 : result.code, { detail: `${cause}; ${hint}` });
      if (file) warn(`install output recorded to ${file}`);
    } catch {
      /* logging must never break the runner */
    }
  }

  // An evaluation requested while the install ran: its `force`, or null.
  function takeRerun() {
    if (!rerun || closed) return null;
    const f = rerunForce;
    rerun = false;
    rerunForce = false;
    return f;
  }

  async function evaluate(force) {
    if (closed) return;
    if (installing) {
      rerun = true;
      rerunForce = rerunForce || force;
      return;
    }
    const stale = safeCheck();
    if (!stale) return;
    const sig = signature(dir);
    const action = planDepsAction({ staleCount: stale.length, signature: sig, failedSignature, force, failures });
    if (action === 'in-step') {
      if (failedSignature !== null) log(`${label} dependencies are back in step.`);
      else if (force) log(`${label} dependencies are in step — nothing to install.`);
      markInStep();
      return;
    }
    if (action === 'skip-failed') {
      logSkip(sig);
      return;
    }

    const result = await runInstall(stale);
    if (closed) return;

    const after = safeCheck();
    const ok = result.code === 0 && after !== null && after.length === 0;
    if (ok) {
      markInStep();
      log(`'npm install' in ${label} finished — dependencies are in step.`);
    } else {
      reportFailure(result, after, sig);
    }
    try {
      await afterInstall({ ok, code: result.code });
    } catch (err) {
      warn(`after-install step for ${label} failed: ${err?.message ?? err}`);
    }
    const again = takeRerun();
    if (again !== null) await evaluate(again);
  }

  function run(force) {
    settled = evaluate(force).catch((err) => warn(`dependency watch for ${label} failed: ${err?.message ?? err}`));
    return settled;
  }

  function onEvent(_eventType, filename) {
    if (closed || !isManifestEvent(filename)) return;
    if (debounce) unschedule(debounce);
    debounce = schedule(() => {
      debounce = null;
      void run(false);
    }, debounceMs);
  }

  function start() {
    if (closed || watcher) return;
    // Out of step already (a boot-time repair that failed, e.g. on a locked
    // native module): treat the current files as "already failed" so the
    // watcher does not immediately repeat what preflight just tried.
    const stale = safeCheck();
    if (stale && stale.length > 0) {
      failedSignature = signature(dir);
      warn(
        `${label}: ${stale.length} dependency item(s) are out of step at startup ` +
          `(${describeStale(stale)}) — not auto-installing until ` +
          'package.json / package-lock.json change (or type `i`).',
      );
    }
    try {
      // The directory, not the files: git and editors replace a file by
      // rename, which silently ends a watch on the file itself.
      watcher = watch(dir, onEvent);
      watcher.on?.('error', (err) => {
        warn(`dependency watch for ${label} stopped: ${err?.message ?? err} (restart npm run dev to re-arm it)`);
        try {
          watcher?.close();
        } catch {
          /* ignore */
        }
        watcher = null;
      });
    } catch (err) {
      warn(`could not watch ${label} package.json / package-lock.json: ${err?.message ?? err}`);
      watcher = null;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (debounce) unschedule(debounce);
    debounce = null;
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
    watcher = null;
    current?.kill();
  }

  return {
    start,
    close,
    /** Evaluate now; `force` retries even an already-failed signature. */
    recheck: ({ force = false } = {}) => run(force),
    isInstalling: () => installing,
    /** Test seam: the latest evaluation's promise. */
    settled: () => settled,
  };
}
