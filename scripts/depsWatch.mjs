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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { checkWorkspaceDeps, describeStaleDep } from './depsCheck.mjs';
import { recordExit, recordOutput } from './orchestrate/devLog.mjs';

export const DEPS_MANIFEST_FILES = ['package.json', 'package-lock.json'];
// A merge writes package.json and package-lock.json a few ms apart, and an
// editor save can land as write + rename. One install per burst.
export const DEPS_WATCH_DEBOUNCE_MS = 2000;
const MAX_OUTPUT_CHARS = 64 * 1024;
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

/** Pure: was an install failure a locked file, and was that file node-pty's? */
export function classifyInstallFailure(output) {
  const text = String(output ?? '');
  const locked = /\b(EBUSY|EPERM)\b/.test(text);
  return { locked, nodePty: locked && /node-pty/i.test(text) };
}

/** Pure: the actionable next step for a failed install. */
export function installFailureHint({ locked, nodePty }, platform = process.platform) {
  if (nodePty) {
    return (
      "node-pty's native module is loaded by the detached terminal-server that hosts every agent terminal" +
      (platform === 'win32' ? ", and Windows won't replace a loaded .node file" : '') +
      '. A soft restart (`r`) keeps that server alive, so it cannot free the file: when your agents are ' +
      'idle, Ctrl+C and run `npm run dev` again (preflight installs before anything loads node-pty). ' +
      'The running stack stays on the old dependencies meanwhile.'
    );
  }
  if (locked) {
    return (
      'a file under node_modules is held open by a running process (the backend, vite/esbuild, an editor ' +
      'or antivirus). A soft restart (`r` in the npm run dev console) stops the backend and vite while ' +
      'keeping agents running, and re-runs the install in preflight; or type `i` to retry.'
    );
  }
  return (
    'see the npm output above. Nothing retries automatically until package.json / package-lock.json ' +
    'change again; type `i` in the npm run dev console to retry sooner.'
  );
}

// Kill an install and everything it started (node-gyp, postinstall scripts).
// None of it is an ancestor of the terminal-server, so a tree kill is safe.
function killInstallTree(child, platform = process.platform) {
  if (!child || child.exitCode !== null || child.signalCode != null) return;
  if (platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

/**
 * Run `npm install` in `cwd`. Output is forwarded line by line, kept in the
 * dev-runner log tail under `recordLabel`, and returned (bounded) so the caller
 * can classify a failure.
 * @returns {{ done: Promise<{ code: number, output: string }>, kill(): void }}
 */
export function runNpmInstall({
  cwd,
  recordLabel,
  forward = (line, stream) => process[stream].write(`${line}\n`),
  spawnProcess = spawn,
  platform = process.platform,
}) {
  // On Windows npm is a .cmd shim that only a shell can launch: ONE constant
  // command string, never args + shell:true (DEP0190).
  const win = platform === 'win32';
  let child = null;
  let output = '';
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      resolve({ code, output: output + extra });
    };
    try {
      child = spawnProcess(win ? 'npm install' : 'npm', win ? [] : ['install'], {
        cwd,
        // Never the dev runner's stdin: under the orchestrator that is the
        // control pipe, and a child reading it would swallow commands.
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: win,
        windowsHide: true,
      });
    } catch (err) {
      finish(1, String(err?.message ?? err));
      return;
    }
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const emit = (line) => {
        recordOutput(recordLabel, line);
        output = (output + line + '\n').slice(-MAX_OUTPUT_CHARS);
        try {
          forward(line, stream);
        } catch {
          /* logging must never break the runner */
        }
      };
      child[stream]?.on('data', (chunk) => {
        pending += decoder.write(chunk);
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          emit(pending.slice(0, end).replace(/\r$/, ''));
          pending = pending.slice(end + 1);
        }
      });
      child[stream]?.on('end', () => {
        pending += decoder.end();
        if (pending) emit(pending);
        pending = '';
      });
    }
    // 'close', not 'exit': the output classification needs the final lines.
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (err) => finish(1, String(err?.message ?? err)));
  });
  return { done, kill: () => killInstallTree(child, platform) };
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
      failedSignature = null;
      failures = 0;
      skipLogged = false;
      return;
    }
    if (action === 'skip-failed') {
      if (!skipLogged) {
        skipLogged = true;
        log(
          failedSignature === sig
            ? `${label} dependencies are still out of step, but 'npm install' already failed for these ` +
                'package.json / package-lock.json contents — not retrying until they change (or type `i`).'
            : `${label} dependencies are still out of step after ${failures} failed installs in a row — ` +
                'not retrying automatically (type `i` to retry).',
        );
      }
      return;
    }

    installing = true;
    log(
      `${label}: ${stale.length} dependency item(s) out of step with package.json / package-lock.json ` +
        `(${stale.map((d) => describeStaleDep(d)).join(', ')}) — running 'npm install' in ${label}...`,
    );
    let result;
    try {
      await beforeInstall();
      if (closed) {
        installing = false;
        return;
      }
      current = install({ recordLabel });
      result = await current.done;
    } catch (err) {
      result = { code: 1, output: String(err?.message ?? err) };
    }
    current = null;
    installing = false;
    if (closed) return;

    const after = safeCheck();
    const ok = result.code === 0 && after !== null && after.length === 0;
    if (ok) {
      failedSignature = null;
      failures = 0;
      skipLogged = false;
      log(`'npm install' in ${label} finished — dependencies are in step.`);
    } else {
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
            (after?.length ? ` (${after.map((d) => describeStaleDep(d)).join(', ')})` : '')
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
    try {
      await afterInstall({ ok, code: result.code });
    } catch (err) {
      warn(`after-install step for ${label} failed: ${err?.message ?? err}`);
    }
    if (rerun && !closed) {
      const f = rerunForce;
      rerun = false;
      rerunForce = false;
      await evaluate(f);
    }
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
          `(${stale.map((d) => describeStaleDep(d)).join(', ')}) — not auto-installing until ` +
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
