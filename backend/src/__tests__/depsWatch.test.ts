import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StaleDep } from '../../../scripts/depsCheck.mjs';
import {
  classifyInstallFailure,
  createDepsWatcher,
  installFailureHint,
  isManifestEvent,
  manifestSignature,
  MAX_AUTO_INSTALL_FAILURES,
  planDepsAction,
  type InstallResult,
} from '../../../scripts/depsWatch.mjs';

// Regression for: a merge fast-forwarded main with a new backend dependency
// while `npm run dev` was up; deps were only checked at boot, so `tsc -w`
// failed "Cannot find module" and the backend silently stayed on old code.
// The watcher installs on a manifest/lock MISMATCH and never loops: a failed
// install is not retried until the files change again (or `i` forces it).

test('planDepsAction: in step, install, and the failed-signature loop guard', () => {
  assert.equal(planDepsAction({ staleCount: 0, signature: 'a', failedSignature: null }), 'in-step');
  assert.equal(planDepsAction({ staleCount: 2, signature: 'a', failedSignature: null }), 'install');
  assert.equal(planDepsAction({ staleCount: 2, signature: 'a', failedSignature: 'a' }), 'skip-failed');
  assert.equal(planDepsAction({ staleCount: 2, signature: 'b', failedSignature: 'a' }), 'install');
  assert.equal(planDepsAction({ staleCount: 2, signature: 'a', failedSignature: 'a', force: true }), 'install');
  // Consecutive failures cap automatic retries even for "new" contents.
  assert.equal(
    planDepsAction({ staleCount: 2, signature: 'c', failedSignature: 'a', failures: MAX_AUTO_INSTALL_FAILURES }),
    'skip-failed',
  );
  assert.equal(
    planDepsAction({ staleCount: 2, signature: 'c', failedSignature: 'a', failures: MAX_AUTO_INSTALL_FAILURES, force: true }),
    'install',
  );
});

test('isManifestEvent only reacts to package.json / package-lock.json (or an unnamed event)', () => {
  assert.equal(isManifestEvent('package.json'), true);
  assert.equal(isManifestEvent('package-lock.json'), true);
  assert.equal(isManifestEvent(null), true);
  assert.equal(isManifestEvent('package.json~'), false);
  assert.equal(isManifestEvent('src'), false);
  assert.equal(isManifestEvent('node_modules'), false);
});

test('manifestSignature changes with either file and tolerates a missing lockfile', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-depswatch-'));
  try {
    await fs.writeFile(path.join(dir, 'package.json'), '{"dependencies":{}}');
    const a = manifestSignature(dir);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
    const b = manifestSignature(dir);
    assert.notEqual(a, b);
    assert.equal(manifestSignature(dir), b);
    await fs.writeFile(path.join(dir, 'package.json'), '{"dependencies":{"x":"1"}}');
    assert.notEqual(manifestSignature(dir), b);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('classifyInstallFailure + hint: node-pty EBUSY points at the terminal-server, not a soft restart', () => {
  const pty = classifyInstallFailure(
    "npm error code EBUSY\nnpm error syscall unlink\nnpm error path C:\\x\\node_modules\\node-pty\\build\\Release\\conpty.node",
  );
  assert.deepEqual(pty, { locked: true, nodePty: true });
  const hint = installFailureHint(pty, 'win32');
  assert.match(hint, /terminal-server/);
  assert.match(hint, /Ctrl\+C/);
  assert.match(hint, /cannot free the file/);

  const other = classifyInstallFailure('npm error code EPERM\nnpm error path ...\\esbuild.exe');
  assert.deepEqual(other, { locked: true, nodePty: false });
  assert.match(installFailureHint(other, 'win32'), /soft restart/);

  const plain = classifyInstallFailure('npm error code E404');
  assert.deepEqual(plain, { locked: false, nodePty: false });
  assert.match(installFailureHint(plain), /change again/);
});

// ---- the watcher, against fakes ----

function fixture(initial: { stale: StaleDep[]; sig: string }) {
  const state = { ...initial };
  const logs: string[] = [];
  const records: Array<{ label: string; code: number; detail: string }> = [];
  const installs: Array<{ resolve: (r: InstallResult) => void; killed: boolean }> = [];
  const after: Array<{ ok: boolean; code: number }> = [];
  const events: string[] = [];
  let listener: ((eventType: string, filename: string | null) => void) | null = null;
  const watcherHandle = Object.assign(new EventEmitter(), { closed: false, close() { watcherHandle.closed = true; } });
  let scheduled: (() => void) | null = null;
  const watcher = createDepsWatcher({
    dir: '/ws',
    label: 'frontend',
    log: (m) => logs.push(m),
    warn: (m) => logs.push(`WARN ${m}`),
    check: () => state.stale,
    signature: () => state.sig,
    install: () => {
      const entry = { resolve: (_r: InstallResult) => {}, killed: false };
      const done = new Promise<InstallResult>((resolve) => { entry.resolve = resolve; });
      installs.push(entry);
      return { done, kill: () => { entry.killed = true; } };
    },
    beforeInstall: () => { events.push('before'); },
    afterInstall: (r) => { events.push('after'); after.push(r); },
    record: (label, code, { detail }) => { records.push({ label, code, detail }); return null; },
    watch: (_dir, l) => { listener = l; return watcherHandle; },
    schedule: (fn) => { scheduled = fn; return 1; },
    unschedule: () => { scheduled = null; },
  });
  const fire = (filename: string | null) => {
    listener!('change', filename);
  };
  const flushDebounce = () => {
    const fn = scheduled;
    scheduled = null;
    fn?.();
    return watcher.settled();
  };
  return { state, logs, records, installs, after, events, watcher, watcherHandle, fire, flushDebounce, pendingDebounce: () => scheduled !== null };
}

const missing = (name: string): StaleDep => ({ name, reason: 'missing' });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a manifest change that leaves deps stale installs once, then reports in step', async () => {
  const f = fixture({ stale: [], sig: 's0' });
  f.watcher.start();
  f.fire('src'); // unrelated entry
  assert.equal(f.pendingDebounce(), false);

  f.state.stale = [missing('zod')];
  f.state.sig = 's1';
  f.fire('package.json');
  f.fire('package-lock.json'); // same burst → one evaluation
  const run = f.flushDebounce();
  await tick();
  assert.equal(f.installs.length, 1);
  assert.deepEqual(f.events, ['before']);
  f.state.stale = [];
  f.installs[0].resolve({ code: 0, output: '' });
  await run;
  assert.deepEqual(f.after, [{ ok: true, code: 0 }]);
  assert.deepEqual(f.events, ['before', 'after']);
  assert.ok(f.logs.some((l) => /finished — dependencies are in step/.test(l)));
  assert.equal(f.records.length, 0);
});

test('a file event with deps already in step (npm rewriting its own lockfile) installs nothing', async () => {
  const f = fixture({ stale: [], sig: 's0' });
  f.watcher.start();
  f.state.sig = 's1';
  f.fire('package-lock.json');
  await f.flushDebounce();
  assert.equal(f.installs.length, 0);
});

test('a failed install is recorded, not retried for the same files, retried when they change or on force', async () => {
  const f = fixture({ stale: [missing('node-pty')], sig: 'bad' });
  // Out of step at start (a boot repair that failed): no immediate retry.
  f.watcher.start();
  assert.ok(f.logs.some((l) => /out of step at startup/.test(l)));
  f.fire('package.json');
  await f.flushDebounce();
  assert.equal(f.installs.length, 0);

  // The files change → install; it fails on a locked node-pty.
  f.state.sig = 'bad2';
  f.fire('package.json');
  const run = f.flushDebounce();
  await tick();
  assert.equal(f.installs.length, 1);
  f.installs[0].resolve({ code: 1, output: 'npm error code EBUSY\n...node_modules\\node-pty\\build\\conpty.node' });
  await run;
  assert.deepEqual(f.after, [{ ok: false, code: 1 }]);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].label, 'npm-install-frontend');
  assert.match(f.records[0].detail, /EBUSY\/EPERM/);
  assert.ok(f.logs.some((l) => /hint: .*terminal-server/.test(l)));

  // Same files again (npm touched the lockfile, or an unrelated save) → skip, logged once.
  const logsBefore = f.logs.length;
  f.fire('package-lock.json');
  await f.flushDebounce();
  f.fire('package-lock.json');
  await f.flushDebounce();
  assert.equal(f.installs.length, 1);
  assert.equal(f.logs.slice(logsBefore).filter((l) => /already failed/.test(l)).length, 1);

  // `i` forces a retry of the very same files.
  const forced = f.watcher.recheck({ force: true });
  await tick();
  assert.equal(f.installs.length, 2);
  f.state.stale = [];
  f.installs[1].resolve({ code: 0, output: '' });
  await forced;
  assert.deepEqual(f.after.at(-1), { ok: true, code: 0 });
});

test('exit 0 with deps still stale counts as a failure (no install loop)', async () => {
  const f = fixture({ stale: [], sig: 's0' });
  f.watcher.start();
  f.state.stale = [missing('left-pad')];
  f.state.sig = 's1';
  f.fire('package.json');
  const run = f.flushDebounce();
  await tick();
  f.installs[0].resolve({ code: 0, output: '' });
  await run;
  assert.deepEqual(f.after, [{ ok: false, code: 0 }]);
  assert.match(f.records[0].detail, /still out of step/);
  f.fire('package-lock.json');
  await f.flushDebounce();
  assert.equal(f.installs.length, 1);
});

test('changes during an install are re-evaluated once it finishes', async () => {
  const f = fixture({ stale: [], sig: 's0' });
  f.watcher.start();
  f.state.stale = [missing('a')];
  f.state.sig = 's1';
  f.fire('package.json');
  const run = f.flushDebounce();
  await tick();
  // A second merge lands mid-install.
  f.state.sig = 's2';
  f.fire('package.json');
  void f.flushDebounce();
  assert.equal(f.installs.length, 1);
  // First install fixes 'a' but the second merge added 'b'.
  f.state.stale = [missing('b')];
  f.installs[0].resolve({ code: 0, output: '' });
  await tick();
  await tick();
  assert.equal(f.installs.length, 2);
  f.state.stale = [];
  f.installs[1].resolve({ code: 0, output: '' });
  await run;
  assert.equal(f.after.length, 2);
  assert.deepEqual(f.after[1], { ok: true, code: 0 });
});

test('close() kills an in-flight install, stops watching and skips afterInstall', async () => {
  const f = fixture({ stale: [], sig: 's0' });
  f.watcher.start();
  f.state.stale = [missing('a')];
  f.state.sig = 's1';
  f.fire('package.json');
  const run = f.flushDebounce();
  await tick();
  f.watcher.close();
  assert.equal(f.installs[0].killed, true);
  assert.equal(f.watcherHandle.closed, true);
  f.installs[0].resolve({ code: 1, output: '' });
  await run;
  assert.deepEqual(f.after, []);
  assert.equal(f.records.length, 0);
});

test('a watcher runtime error is logged and does not throw', () => {
  const f = fixture({ stale: [], sig: 's0' });
  f.watcher.start();
  f.watcherHandle.emit('error', new Error('EPERM watch'));
  assert.ok(f.logs.some((l) => /dependency watch for frontend stopped: EPERM watch/.test(l)));
  assert.equal(f.watcherHandle.closed, true);
});

test('after repeated failures only a forced re-check installs', async () => {
  const f = fixture({ stale: [missing('a')], sig: 'x0' });
  f.watcher.start(); // stale at start: 'x0' counts as already failed
  for (let i = 1; i <= MAX_AUTO_INSTALL_FAILURES; i++) {
    f.state.sig = `x${i}`;
    f.fire('package.json');
    const run = f.flushDebounce();
    await tick();
    f.installs.at(-1)!.resolve({ code: 1, output: 'npm error code E500' });
    await run;
  }
  assert.equal(f.installs.length, MAX_AUTO_INSTALL_FAILURES);
  f.state.sig = 'fresh';
  f.fire('package.json');
  await f.flushDebounce();
  assert.equal(f.installs.length, MAX_AUTO_INSTALL_FAILURES);
  assert.ok(f.logs.some((l) => /failed installs in a row/.test(l)));
  const forced = f.watcher.recheck({ force: true });
  await tick();
  assert.equal(f.installs.length, MAX_AUTO_INSTALL_FAILURES + 1);
  f.state.stale = [];
  f.installs.at(-1)!.resolve({ code: 0, output: '' });
  await forced;
  assert.deepEqual(f.after.at(-1), { ok: true, code: 0 });
});
